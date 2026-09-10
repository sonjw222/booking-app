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

  /*
    Privacy Emergency Fix Batch (2026-09-10, P0-1/P0-2) — 탈퇴 후에도 push 토큰/Storage
    avatar object가 남아있던 문제(개인정보 실사 N섹션 1/2번) 검증. 별도 fixture로 실행
    (위 테스트와 독립) — 이 계정은 push_subscriptions(항상 존재)와 native_push_tokens
    (add_native_push_tokens.sql이 아직 이 프로젝트 운영 DB에 적용되지 않았으면 없을 수
    있음 — 2026-09-10 확인됨, 그 경우 이 서브케이스는 자동으로 건너뛴다)에 기기 토큰을
    실제로 등록해두고, avatar도 avatars 버킷에 실제 object로 올려둔 뒤 탈퇴시켜 둘 다
    실제로 지워지는지 확인한다.

    주의: delete-account Edge Function은 "배포된" 버전을 호출한다(functions.invoke가
    로컬 코드를 실행하는 게 아니다) — 이 테스트는 코드 수정과 별개로 `supabase functions
    deploy delete-account`가 실행된 뒤에만 새 동작을 검증할 수 있다. 배포 전에는 기존
    (구) 배포본이 호출되어 아래 새 단언이 실패하는 게 정상이다 — 그 실패 자체가 이번
    배치가 고치려는 버그가 실제로 운영에 남아있다는 증거다.
  */
  it("탈퇴 시 native_push_tokens/push_subscriptions 전부 삭제 + avatar Storage object 실제 삭제 (P0-1/P0-2)", async () => {
    const admin = getFixtureAdminClient();
    const runId2 = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const email2 = `qa-delete-push-${runId2}@example.com`;
    const password2 = `Qa-delete-push-pw-${runId2}`;
    const phone2 = `010-${runId2.slice(0, 4)}-${runId2.slice(-4).padStart(4, "0")}`;
    const avatarKey = `qa-delete-avatar-${runId2}.png`;
    // 1x1 투명 PNG — 실제 object 존재/삭제를 검증하기 위한 최소 크기 실제 파일.
    const onePixelPng = Uint8Array.from(
      atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="),
      (c) => c.charCodeAt(0)
    );

    let authId2 = "";
    let accountId2 = "";
    let nativePushTokensAvailable = true;

    try {
      const created = await admin.auth.admin.createUser({ email: email2, password: password2, email_confirm: true });
      if (created.error || !created.data.user) throw new Error(`테스트용 auth 계정 생성 실패: ${created.error?.message}`);
      authId2 = created.data.user.id;

      const accIns = await admin
        .from("accounts")
        .insert({ auth_id: authId2, name: "탈퇴QA토큰원본", phone: phone2, is_member: true })
        .select("id")
        .single();
      if (accIns.error || !accIns.data) throw new Error(`accounts 생성 실패: ${accIns.error?.message}`);
      accountId2 = accIns.data.id as string;

      // 실제 avatar 파일을 avatars 버킷에 올리고, profiles.avatar_url에는 실제 코드
      // (lib/profiles.ts uploadAvatar)와 동일하게 "순수 object key"만 저장한다.
      const uploadRes = await admin.storage.from("avatars").upload(avatarKey, onePixelPng, {
        contentType: "image/png", upsert: false,
      });
      if (uploadRes.error) throw new Error(`avatar 업로드 실패: ${uploadRes.error.message}`);

      const profIns = await admin
        .from("profiles")
        .insert({
          account_id: accountId2, name: "탈퇴QA토큰본인", avatar_url: avatarKey, is_primary: true,
        })
        .select("id")
        .single();
      if (profIns.error || !profIns.data) throw new Error(`profiles 생성 실패: ${profIns.error?.message}`);

      // push_subscriptions(웹푸시) — 이 프로젝트에 항상 존재하는 테이블.
      const subIns = await admin.from("push_subscriptions").insert([
        { account_id: accountId2, endpoint: `https://qa-delete-push-${runId2}.example/ep1`, p256dh: "p256dh-fixture", auth: "auth-fixture" },
        { account_id: accountId2, endpoint: `https://qa-delete-push-${runId2}.example/ep2`, p256dh: "p256dh-fixture-2", auth: "auth-fixture-2" },
      ]);
      if (subIns.error) throw new Error(`push_subscriptions 생성 실패: ${subIns.error.message}`);

      // native_push_tokens(FCM) — 여러 기기(ios+android) 보유 시나리오. 테이블이 아직
      // 운영 DB에 없으면(add_native_push_tokens.sql 미적용) 이 서브케이스만 건너뛴다.
      const nativeIns = await admin.from("native_push_tokens").insert([
        { account_id: accountId2, platform: "ios", token: `qa-ios-token-${runId2}` },
        { account_id: accountId2, platform: "android", token: `qa-android-token-${runId2}` },
      ]);
      if (nativeIns.error) {
        if ((nativeIns.error as { code?: string }).code === "42P01") {
          nativePushTokensAvailable = false;
        } else {
          throw new Error(`native_push_tokens 생성 실패: ${nativeIns.error.message}`);
        }
      }

      const asDeletingUser: SupabaseClient = createClient(url, anonKey, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      const signIn = await asDeletingUser.auth.signInWithPassword({ email: email2, password: password2 });
      if (signIn.error || !signIn.data.session) throw new Error(`테스트 계정 로그인 실패: ${signIn.error?.message}`);

      const invoked = await asDeletingUser.functions.invoke("delete-account");
      expect(invoked.error).toBeFalsy();

      // P0-1: 토큰/구독이 실제로 전부 삭제됐는지
      const subsAfter = await admin.from("push_subscriptions").select("id").eq("account_id", accountId2);
      expect(subsAfter.error).toBeFalsy();
      expect(subsAfter.data?.length ?? -1).toBe(0);

      if (nativePushTokensAvailable) {
        const nativeAfter = await admin.from("native_push_tokens").select("id").eq("account_id", accountId2);
        expect(nativeAfter.error).toBeFalsy();
        expect(nativeAfter.data?.length ?? -1).toBe(0);
      }

      // P0-2: avatar_url 컬럼뿐 아니라 실제 Storage object도 지워졌는지
      const profAfter = await admin.from("profiles").select("avatar_url").eq("account_id", accountId2).single();
      expect(profAfter.error).toBeFalsy();
      expect(profAfter.data?.avatar_url).toBeNull();

      const downloadAfter = await admin.storage.from("avatars").download(avatarKey);
      expect(downloadAfter.error).toBeTruthy(); // object가 없어야 함(삭제 확인)

      authId2 = ""; // delete-account가 auth.users도 지웠음 — afterAll에서 재삭제 안 함
    } finally {
      // best-effort 정리 — 위 어느 단언이 실패해도(=아직 배포 전이라 old 코드가 호출돼
      // 토큰/파일이 안 지워진 경우 포함) 이 테스트가 운영 프로젝트에 fixture를 남기지 않게 한다.
      if (accountId2) {
        await admin.from("push_subscriptions").delete().eq("account_id", accountId2).catch(() => {});
        await admin.from("native_push_tokens").delete().eq("account_id", accountId2).catch(() => {});
        await admin.from("profiles").delete().eq("account_id", accountId2).catch(() => {});
        await admin.from("accounts").delete().eq("id", accountId2).catch(() => {});
      }
      await admin.storage.from("avatars").remove([avatarKey]).catch(() => {});
      if (authId2) await admin.auth.admin.deleteUser(authId2).catch(() => {});
    }
  });
});
