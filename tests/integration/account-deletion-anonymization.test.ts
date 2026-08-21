/*
  P1-18 — 계정 탈퇴 정책(소프트 비활성화 → 실제 개인정보 익명화 + auth.users 삭제) 검증.

  supabase/functions/delete-account를 실제로 배포된 상태 그대로 호출해(로컬 mock 없음)
  다음을 확인한다:
    1) accounts/profiles(가족 프로필 포함) 개인정보가 정말 익명화되는지
    2) auth.users 행이 밴이 아니라 실제로 삭제되는지
    3) 같은 이메일로 즉시 재가입할 수 있는지(사용자 결정: 재가입 허용, 대기기간 없음)

  전용 임시 계정을 매 실행 새로 만들어 쓴다(setup.ts의 공유 TEST_USER_A/B와 무관) —
  탈퇴 자체가 계정을 소멸시키는 일회성 동작이라 재사용 가능한 fixture가 아니고, 공유
  싱글턴(lib/supabaseClient.ts)의 로그인 상태를 건드리면 다른 통합테스트 파일과
  auth 세션이 꼬일 수 있어 별도 client 인스턴스로만 로그인한다.
*/
import { describe, it, expect, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getFixtureAdminClient, requireEnv } from "./setup";

describe("계정 탈퇴 — 실제 개인정보 익명화 + auth 삭제 (P1-18)", () => {
  const url = requireEnv("NEXT_PUBLIC_SUPABASE_URL");
  const anonKey = requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");

  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const email = `qa-delete-${runId}@example.com`;
  const password = `Qa-delete-pw-${runId}`;
  // accounts.phone은 unique 제약이 있어 실행마다 겹치지 않게 runId 일부를 섞는다.
  const phone = `010-${runId.slice(0, 4)}-${runId.slice(-4).padStart(4, "0")}`;

  let authId = "";
  let accountId = "";
  let resignupAuthId = "";

  afterAll(async () => {
    // best-effort 정리: 단언 실패로 중간에 끊겨도 테스트 전용 계정을 남기지 않는다.
    const admin = getFixtureAdminClient();
    if (accountId) {
      try {
        await admin.from("profiles").delete().eq("account_id", accountId);
      } catch { /* best-effort */ }
      try {
        await admin.from("accounts").delete().eq("id", accountId);
      } catch { /* best-effort */ }
    }
    if (authId) await admin.auth.admin.deleteUser(authId).catch(() => {});
    if (resignupAuthId) await admin.auth.admin.deleteUser(resignupAuthId).catch(() => {});
  });

  it("탈퇴 호출 후 개인정보 익명화 + auth 실제 삭제 + 같은 이메일 재가입까지 왕복 확인", async () => {
    const admin = getFixtureAdminClient();

    // 1) 전용 테스트 auth 계정 생성 — email_confirm:true로 "Confirm email" 설정과 무관하게
    //    즉시 로그인 가능하게 만든다(setup.ts switchToTestUser의 signUp 경로와 달리, 여기선
    //    서비스 역할로 확정 상태까지 바로 만든다).
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (created.error || !created.data.user) {
      throw new Error(`테스트용 auth 계정 생성 실패: ${created.error?.message}`);
    }
    authId = created.data.user.id;

    // 2) accounts/profiles(본인 + 자녀 프로필) fixture — 실제 가입 화면 로직은 이 테스트의
    //    대상이 아니므로 service_role로 직접 채워 넣는다.
    const accIns = await admin
      .from("accounts")
      .insert({ auth_id: authId, name: "탈퇴QA원본이름", phone, address: "서울시 QA구 테스트동", is_member: true })
      .select("id")
      .single();
    if (accIns.error || !accIns.data) throw new Error(`accounts 생성 실패: ${accIns.error?.message}`);
    accountId = accIns.data.id as string;

    const profIns = await admin
      .from("profiles")
      .insert([
        {
          account_id: accountId, name: "탈퇴QA본인", nickname: "본인닉", phone,
          address: "서울시 QA구 테스트동", memo: "메모원본", avatar_url: "https://example.com/a.png",
          birth_date: "1990-01-01", label: "본인", is_primary: true,
        },
        {
          account_id: accountId, name: "탈퇴QA자녀", nickname: "자녀닉", phone: null,
          address: "서울시 QA구 테스트동", memo: "자녀메모", avatar_url: "https://example.com/b.png",
          birth_date: "2015-05-05", label: "자녀", is_primary: false,
        },
      ])
      .select("id");
    if (profIns.error || !profIns.data || profIns.data.length !== 2) {
      throw new Error(`profiles 생성 실패: ${profIns.error?.message ?? "행 개수 불일치"}`);
    }

    // 3) 전용 client로 로그인한 뒤, 배포된 delete-account Edge Function을 실제로 호출한다.
    const asDeletingUser: SupabaseClient = createClient(url, anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const signIn = await asDeletingUser.auth.signInWithPassword({ email, password });
    if (signIn.error || !signIn.data.session) {
      throw new Error(`테스트 계정 로그인 실패: ${signIn.error?.message}`);
    }

    const invoked = await asDeletingUser.functions.invoke("delete-account");
    expect(invoked.error).toBeFalsy();

    // 4) accounts 개인정보 익명화 확인
    const accAfter = await admin
      .from("accounts")
      .select("name, phone, address, deactivated_at")
      .eq("id", accountId)
      .single();
    expect(accAfter.error).toBeFalsy();
    expect(accAfter.data?.name).toBe("탈퇴한 회원");
    expect(accAfter.data?.phone).toBeNull();
    expect(accAfter.data?.address).toBeNull();
    expect(accAfter.data?.deactivated_at).toBeTruthy();

    // 5) profiles(본인 + 자녀) 개인정보 익명화 확인 — 가족 프로필까지 전부 처리돼야 한다.
    const profAfter = await admin
      .from("profiles")
      .select("name, nickname, phone, address, avatar_url, memo, birth_date, label")
      .eq("account_id", accountId);
    expect(profAfter.error).toBeFalsy();
    expect(profAfter.data?.length).toBe(2);
    for (const p of profAfter.data ?? []) {
      const row = p as Record<string, unknown>;
      expect(row.name).toBe("탈퇴한 회원");
      expect(row.nickname).toBeNull();
      expect(row.phone).toBeNull();
      expect(row.address).toBeNull();
      expect(row.avatar_url).toBeNull();
      expect(row.memo).toBeNull();
      expect(row.birth_date).toBeNull();
      expect(row.label).toBeNull();
    }

    // 6) auth.users 행이 밴이 아니라 실제로 삭제됐는지 확인
    const getDeleted = await admin.auth.admin.getUserById(authId);
    expect(getDeleted.error).toBeTruthy();
    authId = ""; // 이미 삭제됨 — afterAll에서 다시 지우지 않도록

    // 7) 재가입 정책(사용자 결정: 대기기간 없이 같은 이메일로 즉시 재가입 허용) 확인
    const resignup = await admin.auth.admin.createUser({
      email, password: `${password}-resignup`, email_confirm: true,
    });
    expect(resignup.error).toBeFalsy();
    expect(resignup.data.user).toBeTruthy();
    resignupAuthId = resignup.data.user?.id ?? "";
  });
});
