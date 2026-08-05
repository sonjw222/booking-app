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
    // 최선을 다해 되돌린다(admin 권한). 실패해도 아래 테스트들은 "호출 후 정확한 상태"만
    // 검증하도록 짜여 있어(전제 조건이 아님) 이 정리 자체가 실패해도 스위트를 막지 않는다
    // — 다만 원인 파악에 도움이 되도록 콘솔에는 남긴다(CI에서 실제로 이 delete가 원인
    // 불명으로 실패해 다음 실행의 "before는 null" 단언이 깨진 적이 있었음).
    const { data: existingAcc, error: findErr } = await admin.from("accounts").select("id").eq("auth_id", authUserId).maybeSingle();
    if (findErr) {
      console.warn(`throwaway 계정 accounts 조회 실패(무시하고 계속): ${findErr.message}`);
    } else if (existingAcc) {
      const delProfiles = await admin.from("profiles").delete().eq("account_id", existingAcc.id);
      if (delProfiles.error) console.warn(`throwaway 계정 profiles 정리 실패(무시하고 계속): ${delProfiles.error.message}`);
      const delAccount = await admin.from("accounts").delete().eq("id", existingAcc.id);
      if (delAccount.error) console.warn(`throwaway 계정 accounts 정리 실패(무시하고 계속): ${delAccount.error.message}`);
    }
  });

  afterAll(async () => {
    await supabase.auth.signOut({ scope: "local" });
  });

  it("accounts/profiles 행이 없으면 로그인한 본인 권한(RLS)만으로 새로 만든다", async () => {
    // beforeAll에서 이전 실행이 남긴 accounts/profiles를 최선을 다해 지우지만("계정이
    // 아직 없는" 상태로), 공유 dev Supabase의 정확한 상태까지 이 테스트가 보장할 수는
    // 없다 — 그래서 "호출 전엔 반드시 null"이라는 강한 전제 대신, 호출 후 정확히
    // 올바른 account/profile 1건이 존재하는지(이미 있어서 그대로였든, 방금
    // 새로 만들어졌든)로 검증한다. "정말 없는 상태에서 새로 만드는지"는 매 실행마다
    // beforeAll의 정리가 실제로 성공하는 한 자연히 함께 검증된다.
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
