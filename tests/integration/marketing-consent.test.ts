/*
  Privacy #1 — 마케팅 정보 수신 동의 실제 저장 검증.

  add_marketing_consent.sql이 추가하는 accounts.marketing_consent/marketing_consent_at
  컬럼과, 그 값을 본인만 바꿀 수 있게 막는 기존 "본인 계정 수정" RLS 정책(추가 트리거 없이
  재사용 — add_marketing_consent.sql 주석 참고)을 실제로 검증한다.

  전용 임시 계정 2개(A/B)를 매 실행 새로 만들어 쓴다 — 동시에 두 세션이 필요해서
  (B가 A의 값을 바꾸려는 시도) setup.ts의 공유 싱글턴(switchToTestUser)을 못 쓰고,
  tests/integration/account-deletion-anonymization.test.ts와 동일하게 별도 client
  인스턴스로 로그인한다.

  ⚠ 이 테스트는 add_marketing_consent.sql이 이 프로젝트의 Supabase에 적용된 뒤에만
  통과한다 — 마이그레이션 적용 전에는 marketing_consent 컬럼 자체가 없어
  "column ... does not exist" 에러로 실패하는 게 정상이다(배포 후 재실행 필요).
*/
import { describe, it, expect, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getFixtureAdminClient, requireEnv, TEST_CENTER_ID } from "./setup";

describe("마케팅 정보 수신 동의 저장/철회 (Privacy #1)", () => {
  const url = requireEnv("NEXT_PUBLIC_SUPABASE_URL");
  const anonKey = requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");

  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const emailA = `qa-consent-a-${runId}@example.com`;
  const emailB = `qa-consent-b-${runId}@example.com`;
  const password = `Qa-consent-pw-${runId}`;

  let authIdA = "";
  let authIdB = "";
  let accountIdA = "";
  let accountIdB = "";

  afterAll(async () => {
    // best-effort 정리 — 단언 실패로 중간에 끊겨도 테스트 전용 계정을 남기지 않는다.
    const admin = getFixtureAdminClient();
    if (accountIdA) await admin.from("accounts").delete().eq("id", accountIdA).then(() => {}, () => {});
    if (accountIdB) await admin.from("accounts").delete().eq("id", accountIdB).then(() => {}, () => {});
    if (authIdA) await admin.auth.admin.deleteUser(authIdA).catch(() => {});
    if (authIdB) await admin.auth.admin.deleteUser(authIdB).catch(() => {});
  });

  it("본인 계정의 marketing_consent를 true→false로 직접 바꿀 수 있고, 다른 계정의 값은 바꿀 수 없다", async () => {
    const admin = getFixtureAdminClient();

    const createdA = await admin.auth.admin.createUser({ email: emailA, password, email_confirm: true });
    if (createdA.error || !createdA.data.user) throw new Error(`테스트 계정 A 생성 실패: ${createdA.error?.message}`);
    authIdA = createdA.data.user.id;
    const createdB = await admin.auth.admin.createUser({ email: emailB, password, email_confirm: true });
    if (createdB.error || !createdB.data.user) throw new Error(`테스트 계정 B 생성 실패: ${createdB.error?.message}`);
    authIdB = createdB.data.user.id;

    const accA = await admin.from("accounts").insert({ auth_id: authIdA, name: "QA 동의 A", is_member: true }).select("id").single();
    if (accA.error || !accA.data) throw new Error(`accounts A 생성 실패: ${accA.error?.message}`);
    accountIdA = accA.data.id as string;
    const accB = await admin.from("accounts").insert({ auth_id: authIdB, name: "QA 동의 B", is_member: true }).select("id").single();
    if (accB.error || !accB.data) throw new Error(`accounts B 생성 실패: ${accB.error?.message}`);
    accountIdB = accB.data.id as string;

    const clientA: SupabaseClient = createClient(url, anonKey);
    const clientB: SupabaseClient = createClient(url, anonKey);
    const signInA = await clientA.auth.signInWithPassword({ email: emailA, password });
    if (signInA.error) throw new Error(`A 로그인 실패: ${signInA.error.message}`);
    const signInB = await clientB.auth.signInWithPassword({ email: emailB, password });
    if (signInB.error) throw new Error(`B 로그인 실패: ${signInB.error.message}`);

    // 1) 본인 계정: 동의(true) 저장
    const setTrue = await clientA
      .from("accounts")
      .update({ marketing_consent: true, marketing_consent_at: new Date().toISOString() })
      .eq("id", accountIdA)
      .select("marketing_consent, marketing_consent_at");
    if (setTrue.error) throw new Error(`본인 동의 저장 실패: ${setTrue.error.message}`);
    expect(setTrue.data?.[0]?.marketing_consent).toBe(true);
    const firstConsentAt = setTrue.data?.[0]?.marketing_consent_at as string;
    expect(firstConsentAt).toBeTruthy();

    // 2) 본인 계정: 철회(false) 저장 — marketing_consent_at도 그 시점으로 갱신되는지
    await new Promise((r) => setTimeout(r, 5));
    const setFalse = await clientA
      .from("accounts")
      .update({ marketing_consent: false, marketing_consent_at: new Date().toISOString() })
      .eq("id", accountIdA)
      .select("marketing_consent, marketing_consent_at");
    if (setFalse.error) throw new Error(`본인 철회 저장 실패: ${setFalse.error.message}`);
    expect(setFalse.data?.[0]?.marketing_consent).toBe(false);
    expect(setFalse.data?.[0]?.marketing_consent_at).not.toBe(firstConsentAt);

    // 3) B가 A의 marketing_consent를 바꾸려 하면 RLS에 막혀 "영향받은 행 0개"여야 한다
    //    (에러가 아니라 조용히 걸러지는 게 PostgREST RLS의 표준 동작 — WHERE엔 걸리지만
    //    UPDATE 정책을 통과 못함).
    const crossUpdate = await clientB
      .from("accounts")
      .update({ marketing_consent: true, marketing_consent_at: new Date().toISOString() })
      .eq("id", accountIdA)
      .select("id");
    expect(crossUpdate.data ?? []).toHaveLength(0);

    // 실제로 안 바뀌었는지 admin으로 재확인
    const verify = await admin.from("accounts").select("marketing_consent").eq("id", accountIdA).single();
    expect(verify.data?.marketing_consent).toBe(false);
  });
});

/*
  Privacy Release Blocker Batch #2 (2026-09-20, P1) — 광고성 알림 팬아웃의 수신 동의 게이트 검증.

  근본 문제: add_marketing_consent.sql로 동의 값은 저장하게 됐지만 "그 값으로 발송 대상을
  거르는" 쪽이 어디에도 연결되지 않아, create_marketing_message_safe()가
  `accounts where is_member = true` 전체에 광고 알림을 만들고 있었다.
  fix_marketing_consent_fanout.sql이 대상 선정 단계에 동의 조건을 넣는다.

  이 describe는 실제 RPC를 호출해 "대상 선정 단계"에서 걸러지는지를 확인한다
  (발송 채널 — 푸시/알림톡 — 은 그 뒤 단계라 여기서 검증 대상이 아니다).

  ⚠ fix_marketing_consent_fanout.sql을 Supabase에 적용하기 전에는 동의하지 않은 계정에도
  알림이 만들어져 아래 "제외" 단언이 실패하는 게 정상이다 — 그 실패 자체가 이번 배치가
  고치려는 문제가 운영에 남아있다는 증거다.
*/
describe("마케팅 팬아웃 수신 동의 게이트 (Privacy Release Blocker #2)", () => {
  const url = requireEnv("NEXT_PUBLIC_SUPABASE_URL");
  const anonKey = requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");

  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const password = `Qa-fanout-pw-${runId}`;

  // authId / accountId를 한 쌍으로 관리 — 정리 순서를 한곳에서 보장한다.
  const created: Array<{ label: string; authId: string; accountId: string }> = [];
  const profileIds: string[] = [];
  const membershipIds: string[] = [];
  const marketingMessageIds: string[] = [];
  const announcementIds: string[] = [];

  function accountIdOf(label: string): string {
    const found = created.find((c) => c.label === label);
    if (!found) throw new Error(`fixture 계정을 찾을 수 없음: ${label}`);
    return found.accountId;
  }

  async function makeAccount(
    label: string,
    extra: Record<string, unknown>
  ): Promise<string> {
    const admin = getFixtureAdminClient();
    const email = `qa-fanout-${label}-${runId}@example.com`;
    const user = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (user.error || !user.data.user) throw new Error(`${label} auth 생성 실패: ${user.error?.message}`);
    const acc = await admin
      .from("accounts")
      .insert({ auth_id: user.data.user.id, name: `QA팬아웃-${label}`, is_member: true, ...extra })
      .select("id")
      .single();
    if (acc.error || !acc.data) throw new Error(`${label} accounts 생성 실패: ${acc.error?.message}`);
    created.push({ label, authId: user.data.user.id, accountId: acc.data.id as string });
    return acc.data.id as string;
  }

  async function marketingNotificationCount(accountId: string, messageId: string): Promise<number> {
    const admin = getFixtureAdminClient();
    const res = await admin
      .from("notifications")
      .select("id")
      .eq("recipient_account_id", accountId)
      .eq("kind", "marketing")
      .contains("data", { marketing_message_id: messageId });
    if (res.error) throw new Error(`알림 조회 실패: ${res.error.message}`);
    return res.data?.length ?? 0;
  }

  afterAll(async () => {
    // best-effort 정리 — FK 순서: 알림 → 공지 → 마케팅메시지 → 수강권 → 프로필 → 계정 → auth
    const admin = getFixtureAdminClient();
    for (const c of created) {
      await admin.from("notifications").delete().eq("recipient_account_id", c.accountId).then(() => {}, () => {});
    }
    for (const id of announcementIds) {
      await admin.from("center_announcements").delete().eq("id", id).then(() => {}, () => {});
    }
    for (const id of marketingMessageIds) {
      await admin.from("marketing_messages").delete().eq("id", id).then(() => {}, () => {});
    }
    for (const id of membershipIds) {
      await admin.from("memberships").delete().eq("id", id).then(() => {}, () => {});
    }
    for (const id of profileIds) {
      await admin.from("profiles").delete().eq("id", id).then(() => {}, () => {});
    }
    for (const c of created) {
      await admin.from("accounts").delete().eq("id", c.accountId).then(() => {}, () => {});
      await admin.auth.admin.deleteUser(c.authId).catch(() => {});
    }
  });

  it("동의자만 마케팅 팬아웃 대상이 되고, 미동의·미설정·탈퇴 계정은 제외되며, 철회하면 이후 발송부터 즉시 빠진다", async () => {
    const admin = getFixtureAdminClient();

    // 발송 주체: 임시 운영자 계정(review-reports.test.ts와 같은 패턴 — service_role은
    // auth.uid()가 없어 is_platform_admin() 체크를 통과하지 못하므로 실제 로그인 세션이 필요).
    const adminAccountId = await makeAccount("operator", { is_platform_admin: true });

    // 대상 후보들
    await makeAccount("yes", { marketing_consent: true, marketing_consent_at: new Date().toISOString() });
    await makeAccount("no", { marketing_consent: false, marketing_consent_at: new Date().toISOString() });
    // "한 번도 설정한 적 없음" — marketing_consent 컬럼을 아예 넘기지 않는다.
    // add_marketing_consent.sql이 `not null default false`로 만들었으므로 DB에 NULL이
    // 들어갈 수 없고, 미설정은 곧 false(=미동의)로 저장된다 — opt-in 원칙이 스키마
    // 차원에서 보장되는 것을 여기서 확인한다(SQL의 `is true`는 그 위에 한 겹 더).
    await makeAccount("unset", {});
    await makeAccount("revoked", { marketing_consent: true, marketing_consent_at: new Date().toISOString() });
    // 탈퇴(익명화)된 계정 — 행은 남고 is_member도 true인 채라 기존 쿼리에선 대상이었다.
    await makeAccount("withdrawn", {
      marketing_consent: true, marketing_consent_at: new Date().toISOString(),
      deactivated_at: new Date().toISOString(),
    });

    const unsetRow = await admin
      .from("accounts").select("marketing_consent").eq("id", accountIdOf("unset")).single();
    expect(unsetRow.error).toBeFalsy();
    expect(unsetRow.data?.marketing_consent).toBe(false);

    // 운영자로 로그인해 실제 RPC 호출
    const operator: SupabaseClient = createClient(url, anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const signIn = await operator.auth.signInWithPassword({
      email: `qa-fanout-operator-${runId}@example.com`, password,
    });
    if (signIn.error) throw new Error(`운영자 로그인 실패: ${signIn.error.message}`);

    // --- 1차 발송: revoked는 아직 동의 상태 ---
    const first = await operator.rpc("create_marketing_message_safe", {
      p_title: `QA 팬아웃 1차 ${runId}`, p_body: "수신 동의 게이트 검증", p_link: null,
    });
    if (first.error) throw new Error(`1차 마케팅 발송 실패: ${first.error.message}`);
    const firstId = first.data as string;
    marketingMessageIds.push(firstId);

    expect(await marketingNotificationCount(accountIdOf("yes"), firstId)).toBe(1);
    expect(await marketingNotificationCount(accountIdOf("revoked"), firstId)).toBe(1);
    expect(await marketingNotificationCount(accountIdOf("no"), firstId)).toBe(0);
    expect(await marketingNotificationCount(accountIdOf("unset"), firstId)).toBe(0);
    expect(await marketingNotificationCount(accountIdOf("withdrawn"), firstId)).toBe(0);

    // target_count는 "실제 발송된 동의 회원 수"여야 한다 — 이 프로젝트의 다른 실계정도
    // 포함되므로 정확한 수 대신 "미동의 fixture가 반영되지 않았다"만 확인한다.
    const msgRow = await admin.from("marketing_messages").select("target_count").eq("id", firstId).single();
    expect(msgRow.error).toBeFalsy();
    const consented = await admin
      .from("accounts")
      .select("id", { count: "exact", head: true })
      .eq("is_member", true)
      .is("deactivated_at", null)
      .eq("marketing_consent", true);
    expect(msgRow.data?.target_count).toBe(consented.count);

    // --- 철회 후 2차 발송: revoked는 이번엔 빠져야 한다 ---
    const revoke = await admin
      .from("accounts")
      .update({ marketing_consent: false, marketing_consent_at: new Date().toISOString() })
      .eq("id", accountIdOf("revoked"));
    if (revoke.error) throw new Error(`철회 처리 실패: ${revoke.error.message}`);

    const second = await operator.rpc("create_marketing_message_safe", {
      p_title: `QA 팬아웃 2차 ${runId}`, p_body: "철회 즉시 반영 검증", p_link: null,
    });
    if (second.error) throw new Error(`2차 마케팅 발송 실패: ${second.error.message}`);
    const secondId = second.data as string;
    marketingMessageIds.push(secondId);

    expect(await marketingNotificationCount(accountIdOf("yes"), secondId)).toBe(1);
    // 철회 후 새로 만들어진 팬아웃에서는 제외 — 캐시된 값이 아니라 발송 시점의 최신 값을 본다.
    expect(await marketingNotificationCount(accountIdOf("revoked"), secondId)).toBe(0);
    // 1차에서 이미 받은 알림은 그대로 남는다(소급 삭제 아님).
    expect(await marketingNotificationCount(accountIdOf("revoked"), firstId)).toBe(1);

    expect(adminAccountId).toBeTruthy();
  });

  it("필수 운영 알림(센터 공지 팬아웃)은 marketing_consent = false여도 그대로 발송된다 (회귀)", async () => {
    const admin = getFixtureAdminClient();

    // 위 테스트에서 만든 "no"(미동의) 계정에 프로필 + TEST_CENTER_ID 수강권을 붙여
    // create_announcement()의 팬아웃 대상이 되게 한다(그 함수는 수강권/예약 보유자를 고름).
    const noAccountId = accountIdOf("no");
    const prof = await admin
      .from("profiles")
      .insert({ account_id: noAccountId, name: "QA팬아웃-no-본인", is_primary: true })
      .select("id")
      .single();
    if (prof.error || !prof.data) throw new Error(`프로필 생성 실패: ${prof.error?.message}`);
    profileIds.push(prof.data.id as string);

    const mem = await admin
      .from("memberships")
      .insert({
        profile_id: prof.data.id, center_id: TEST_CENTER_ID, product_name: "QA팬아웃 수강권",
        pass_type: "count", total_count: 1, remaining_count: 1,
        expires_at: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString().slice(0, 10),
        status: "active",
      })
      .select("id")
      .single();
    if (mem.error || !mem.data) throw new Error(`수강권 생성 실패: ${mem.error?.message}`);
    membershipIds.push(mem.data.id as string);

    const operator: SupabaseClient = createClient(url, anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const signIn = await operator.auth.signInWithPassword({
      email: `qa-fanout-operator-${runId}@example.com`, password,
    });
    if (signIn.error) throw new Error(`운영자 로그인 실패: ${signIn.error.message}`);

    const ann = await operator.rpc("create_announcement", {
      p_center_id: TEST_CENTER_ID, p_title: `QA 필수알림 회귀 ${runId}`, p_body: "동의와 무관하게 발송",
    });
    if (ann.error) throw new Error(`공지 발송 실패: ${ann.error.message}`);
    const annId = ann.data as string;
    announcementIds.push(annId);

    // 미동의(marketing_consent=false) 계정도 필수 운영 알림은 그대로 받아야 한다.
    const got = await admin
      .from("notifications")
      .select("id, kind")
      .eq("recipient_account_id", noAccountId)
      .eq("kind", "announcement")
      .contains("data", { announcement_id: annId });
    expect(got.error).toBeFalsy();
    expect(got.data?.length).toBe(1);

    // 동의 여부가 실제로 false인 상태에서 받은 것임을 못박아 둔다.
    const consentNow = await admin.from("accounts").select("marketing_consent").eq("id", noAccountId).single();
    expect(consentNow.data?.marketing_consent).toBe(false);
  });
});
