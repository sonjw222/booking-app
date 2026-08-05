import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { requireEnv, getFixtureAdminClient } from "./setup";
import { supabase } from "../../lib/supabaseClient";
import { ensureAccountForCurrentUser } from "../../lib/authAccount";

/*
  P1: 소셜 로그인(카카오/네이버/애플/구글)으로 처음 로그인하면 auth.users 행만 생기고
  accounts/profiles 행은 아무도 만들어주지 않아 거의 모든 화면이 "계정 정보를 찾을 수
  없어요"로 막혔다(코드 감사로 확인 — 이 정확히 같은 문제를 tests/integration/setup.ts의
  switchToTestUser()가 테스트 픽스처 용도로 이미 개별적으로 우회하고 있었다는 점이 방증).
  lib/authAccount.ts의 ensureAccountForCurrentUser()로 프로덕션 코드 자체에 그 부트스트랩을
  추가했다 — 이 테스트는 실제 RLS(관리자 권한 없이, 로그인한 본인 권한만)로 그 함수가
  정말 accounts/profiles를 만들어내는지, 그리고 이미 있으면 중복 생성하지 않는지 검증한다.

  TEST_USER_A와 같은 메일함을 쓰는 "+e2ebootstrap" 서브주소로 별도의 auth 계정을 만들어
  써서(Confirm email이 꺼져 있어 실제 수신 여부는 무관), 기존 TEST_USER_A/B 계정 상태는
  전혀 건드리지 않는다.
*/

function throwawayCreds(): { email: string; password: string } {
  const base = requireEnv("TEST_USER_A_EMAIL");
  const at = base.indexOf("@");
  const email = at >= 0 ? `${base.slice(0, at)}+e2ebootstrap${base.slice(at)}` : `e2ebootstrap-${base}`;
  return { email, password: requireEnv("TEST_USER_A_PASSWORD") };
}

describe("ensureAccountForCurrentUser (P1 소셜 로그인 신규 계정 부트스트랩)", () => {
  const { email, password } = throwawayCreds();
  let authUserId: string;

  beforeAll(async () => {
    const admin = getFixtureAdminClient();
    await supabase.auth.signOut({ scope: "local" });

    const signIn = await supabase.auth.signInWithPassword({ email, password });
    if (signIn.error || !signIn.data.user) {
      const signUp = await supabase.auth.signUp({ email, password });
      if (signUp.error || !signUp.data.user) {
        throw new Error(`부트스트랩 테스트용 throwaway 계정 준비 실패: ${signUp.error?.message ?? "no user"}`);
      }
      authUserId = signUp.data.user.id;
    } else {
      authUserId = signIn.data.user.id;
    }

    // 이전 실행이 만들어둔 accounts/profiles가 남아있으면 "계정이 아직 없는" 상태로
    // 되돌린다(admin 권한 — RLS로는 본인도 자기 accounts 행을 지울 수 없음, 정책 밖).
    const { data: existingAcc } = await admin.from("accounts").select("id").eq("auth_id", authUserId).maybeSingle();
    if (existingAcc) {
      await admin.from("profiles").delete().eq("account_id", existingAcc.id);
      await admin.from("accounts").delete().eq("id", existingAcc.id);
    }
  });

  afterAll(async () => {
    await supabase.auth.signOut({ scope: "local" });
  });

  it("accounts/profiles 행이 없으면 로그인한 본인 권한(RLS)만으로 새로 만든다", async () => {
    const before = await supabase.from("accounts").select("id").eq("auth_id", authUserId).maybeSingle();
    expect(before.data).toBeNull();

    await ensureAccountForCurrentUser();

    const accountRes = await supabase.from("accounts").select("id, name, is_member, is_manager").eq("auth_id", authUserId).single();
    expect(accountRes.error).toBeNull();
    expect(accountRes.data?.is_member).toBe(true);
    expect(accountRes.data?.is_manager).toBe(false);
    expect(accountRes.data?.name).toBeTruthy();

    const profileRes = await supabase
      .from("profiles")
      .select("id, is_primary")
      .eq("account_id", accountRes.data!.id)
      .single();
    expect(profileRes.error).toBeNull();
    expect(profileRes.data?.is_primary).toBe(true);
  });

  it("이미 있으면 다시 호출해도 중복으로 만들지 않는다(멱등)", async () => {
    await ensureAccountForCurrentUser();
    await ensureAccountForCurrentUser();

    const accounts = await supabase.from("accounts").select("id").eq("auth_id", authUserId);
    expect(accounts.data?.length).toBe(1);

    const profiles = await supabase.from("profiles").select("id").eq("account_id", accounts.data![0].id);
    expect(profiles.data?.length).toBe(1);
  });
});
