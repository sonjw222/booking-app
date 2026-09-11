/*
  Security Hotfix (P0) — accounts.is_platform_admin / accounts.merged_into 자가 수정
  권한 상승·계정 탈취 취약점 검증. fix_accounts_admin_and_merged_into_privilege_
  escalation.sql이 보호하는 두 컬럼이 실제로 잠겨 있는지, 동시에 정상 흐름(관리자
  지정, 계정 연동 RPC, marketing_consent, pg_checkout_override)은 계속 동작하는지
  확인한다.

  ⚠ 이 파일은 fix_accounts_admin_and_merged_into_privilege_escalation.sql이 적용된
  뒤에만 A/B가 통과한다 — 미적용 상태에서 실행하면 A/B가 "차단돼야 하는데 실제로는
  통과됨"으로 실패하는 게 정상이다(취약점이 아직 열려 있다는 증거). 이 파일 자체가
  취약점 재현 스크립트를 겸한다.

  ⚠ D(marketing_consent)는 add_marketing_consent.sql(별도 Privacy 배치, 이번 파일과
  무관)이 적용된 뒤에만 통과한다 — 미적용 상태에서는 "column does not exist"로 실패하는
  게 정상(tests/integration/marketing-consent.test.ts와 동일한 이미 알려진 전제).

  전용 임시 계정을 매 실행 새로 만들어 쓴다 — account-deletion-anonymization.test.ts /
  marketing-consent.test.ts와 동일하게 별도 client 인스턴스로 로그인한다(동시에 여러
  세션이 필요해서 공유 싱글턴을 못 씀).
*/
import { describe, it, expect, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getFixtureAdminClient, requireEnv } from "./setup";

describe("accounts.is_platform_admin / merged_into 권한 상승 방지 (Security Hotfix P0)", () => {
  const url = requireEnv("NEXT_PUBLIC_SUPABASE_URL");
  const anonKey = requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");

  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const emailA = `qa-secfix-a-${runId}@example.com`;
  const emailB = `qa-secfix-b-${runId}@example.com`;
  const emailC = `qa-secfix-c-${runId}@example.com`; // 타인 계정 수정 시도용(H)
  const password = `Qa-secfix-pw-${runId}`;

  let authIdA = "", authIdB = "", authIdC = "";
  let accountIdA = "", accountIdB = "", accountIdC = "";
  let targetAccountId = ""; // B 테스트가 만드는 "가로챌 타깃" 계정 — describe 스코프에 둬서 단언 실패로 일찍 끊겨도 afterAll이 정리할 수 있게 함

  afterAll(async () => {
    // best-effort 정리 — 단언 실패로 중간에 끊겨도 테스트 전용 계정을 남기지 않는다.
    // F(계정 연동)가 성공하면 account_auth_identities/account_link_requests에도 A를
    // 참조하는 행이 남으므로, accounts를 지우기 전에 그 두 테이블부터 먼저 지워야
    // FK 위반 없이 정리된다(실제로 겪은 순서 문제 — 처음엔 이 순서가 아니라서 accounts
    // 삭제가 조용히 실패해 QA 테스트 계정이 남았었음, 수동으로 재정리한 뒤 이 순서로 고침).
    const admin = getFixtureAdminClient();
    for (const id of [accountIdA, accountIdB, accountIdC]) {
      if (id) await admin.from("account_auth_identities").delete().eq("account_id", id).then(() => {}, () => {});
      if (id) await admin.from("account_link_requests").delete().eq("requester_account_id", id).then(() => {}, () => {});
    }
    for (const id of [accountIdA, accountIdB, accountIdC, targetAccountId]) {
      if (id) await admin.from("accounts").delete().eq("id", id).then(() => {}, () => {});
    }
    for (const id of [authIdA, authIdB, authIdC]) {
      if (id) await admin.auth.admin.deleteUser(id).catch(() => {});
    }
  });

  it("A: 본인 is_platform_admin을 false→true로 직접 UPDATE하면 반드시 실패한다", async () => {
    const admin = getFixtureAdminClient();
    const created = await admin.auth.admin.createUser({ email: emailA, password, email_confirm: true });
    if (created.error || !created.data.user) throw new Error(`테스트 계정 A 생성 실패: ${created.error?.message}`);
    authIdA = created.data.user.id;
    const acc = await admin.from("accounts").insert({ auth_id: authIdA, name: "QA 보안A", is_member: true }).select("id").single();
    if (acc.error || !acc.data) throw new Error(`accounts A 생성 실패: ${acc.error?.message}`);
    accountIdA = acc.data.id as string;

    const clientA: SupabaseClient = createClient(url, anonKey);
    const signIn = await clientA.auth.signInWithPassword({ email: emailA, password });
    if (signIn.error) throw new Error(`A 로그인 실패: ${signIn.error.message}`);

    const attempt = await clientA
      .from("accounts")
      .update({ is_platform_admin: true })
      .eq("id", accountIdA)
      .select("is_platform_admin");

    // 트리거가 예외를 던지거나(error), RLS/트리거가 조용히 걸러 0행이 영향받거나 —
    // 어느 쪽이든 "실제로 true가 됐다"는 결과만 아니면 통과. 최종적으로 admin 조회로
    // 실제 DB 값이 false인지 재확인한다(클라이언트 응답만 믿지 않음).
    const blocked = !!attempt.error || (attempt.data ?? []).length === 0;
    expect(blocked).toBe(true);

    const verify = await admin.from("accounts").select("is_platform_admin").eq("id", accountIdA).single();
    expect(verify.data?.is_platform_admin).toBe(false);
  });

  it("B: 본인 merged_into를 다른 account id로 직접 UPDATE하면 반드시 실패한다", async () => {
    const admin = getFixtureAdminClient();
    const created = await admin.auth.admin.createUser({ email: emailB, password, email_confirm: true });
    if (created.error || !created.data.user) throw new Error(`테스트 계정 B 생성 실패: ${created.error?.message}`);
    authIdB = created.data.user.id;
    const acc = await admin.from("accounts").insert({ auth_id: authIdB, name: "QA 보안B", is_member: true }).select("id").single();
    if (acc.error || !acc.data) throw new Error(`accounts B 생성 실패: ${acc.error?.message}`);
    accountIdB = acc.data.id as string;

    // 타깃(가로챌) 계정 — 실제로 존재하는 다른 accounts.id면 충분(로그인 불필요)
    const targetAcc = await admin.from("accounts").insert({ auth_id: crypto.randomUUID(), name: "QA 보안 타깃" }).select("id").single();
    if (targetAcc.error || !targetAcc.data) throw new Error(`타깃 accounts 생성 실패: ${targetAcc.error?.message}`);
    targetAccountId = targetAcc.data.id as string;

    const clientB: SupabaseClient = createClient(url, anonKey);
    const signIn = await clientB.auth.signInWithPassword({ email: emailB, password });
    if (signIn.error) throw new Error(`B 로그인 실패: ${signIn.error.message}`);

    const attempt = await clientB
      .from("accounts")
      .update({ merged_into: targetAccountId })
      .eq("id", accountIdB)
      .select("merged_into");

    const blocked = !!attempt.error || (attempt.data ?? []).length === 0;
    expect(blocked).toBe(true);

    const verify = await admin.from("accounts").select("merged_into").eq("id", accountIdB).single();
    expect(verify.data?.merged_into).toBeNull();
    // targetAccountId 정리는 afterAll이 담당(단언 실패로 여기서 일찍 끊겨도 새게 안 함).
  });

  it("C: 본인 name/phone 등 허용된 필드는 계속 수정할 수 있다", async () => {
    const clientA: SupabaseClient = createClient(url, anonKey);
    const signIn = await clientA.auth.signInWithPassword({ email: emailA, password });
    if (signIn.error) throw new Error(`A 재로그인 실패: ${signIn.error.message}`);

    const attempt = await clientA
      .from("accounts")
      .update({ name: "QA 보안A(수정됨)" })
      .eq("id", accountIdA)
      .select("name");
    if (attempt.error) throw new Error(`허용된 필드 수정 실패: ${attempt.error.message}`);
    expect(attempt.data?.[0]?.name).toBe("QA 보안A(수정됨)");
  });

  it("D: marketing_consent 변경은 계속 성공한다(add_marketing_consent.sql 적용 후에만 통과)", async () => {
    const clientA: SupabaseClient = createClient(url, anonKey);
    const signIn = await clientA.auth.signInWithPassword({ email: emailA, password });
    if (signIn.error) throw new Error(`A 재로그인 실패: ${signIn.error.message}`);

    const attempt = await clientA
      .from("accounts")
      .update({ marketing_consent: true, marketing_consent_at: new Date().toISOString() })
      .eq("id", accountIdA)
      .select("marketing_consent");
    if (attempt.error) throw new Error(`marketing_consent 변경 실패: ${attempt.error.message}`);
    expect(attempt.data?.[0]?.marketing_consent).toBe(true);
  });

  it("E: service_role(admin)은 is_platform_admin을 정상적으로 지정할 수 있다(auth.uid() is null 경로)", async () => {
    const admin = getFixtureAdminClient();
    const attempt = await admin
      .from("accounts")
      .update({ is_platform_admin: true })
      .eq("id", accountIdA)
      .select("is_platform_admin");
    if (attempt.error) throw new Error(`admin의 is_platform_admin 지정 실패: ${attempt.error.message}`);
    expect(attempt.data?.[0]?.is_platform_admin).toBe(true);

    // 원복(다른 테스트/실제 운영자 목록 오염 방지)
    await admin.from("accounts").update({ is_platform_admin: false }).eq("id", accountIdA);
  });

  it("F: 정상 계정 연동 RPC(create_account_link_code → link_accounts_by_code)는 merged_into를 성공적으로 설정한다", async () => {
    const admin = getFixtureAdminClient();
    const created = await admin.auth.admin.createUser({ email: emailC, password, email_confirm: true });
    if (created.error || !created.data.user) throw new Error(`테스트 계정 C 생성 실패: ${created.error?.message}`);
    authIdC = created.data.user.id;
    const acc = await admin.from("accounts").insert({ auth_id: authIdC, name: "QA 보안C(합쳐질 계정)", is_member: true }).select("id").single();
    if (acc.error || !acc.data) throw new Error(`accounts C 생성 실패: ${acc.error?.message}`);
    accountIdC = acc.data.id as string;

    // A(코드 발급자, 남을 계정)로 로그인해 코드 발급
    const clientA: SupabaseClient = createClient(url, anonKey);
    const signInA = await clientA.auth.signInWithPassword({ email: emailA, password });
    if (signInA.error) throw new Error(`A 로그인 실패: ${signInA.error.message}`);
    const codeRes = await clientA.rpc("create_account_link_code");
    if (codeRes.error) throw new Error(`연동 코드 발급 실패: ${codeRes.error.message}`);
    const code = codeRes.data as string;
    expect(code).toBeTruthy();

    // C(합쳐질 계정)로 로그인해 코드 입력
    const clientC: SupabaseClient = createClient(url, anonKey);
    const signInC = await clientC.auth.signInWithPassword({ email: emailC, password });
    if (signInC.error) throw new Error(`C 로그인 실패: ${signInC.error.message}`);
    const linkRes = await clientC.rpc("link_accounts_by_code", { p_code: code });
    if (linkRes.error) throw new Error(`계정 연동 RPC 실패: ${linkRes.error.message}`);

    const verify = await admin.from("accounts").select("merged_into").eq("id", accountIdC).single();
    expect(verify.data?.merged_into).toBe(accountIdA);
  });

  it("G: pg_checkout_override 기존 보호는 회귀 없이 그대로 동작한다", async () => {
    const admin = getFixtureAdminClient();
    const clientA: SupabaseClient = createClient(url, anonKey);
    const signIn = await clientA.auth.signInWithPassword({ email: emailA, password });
    if (signIn.error) throw new Error(`A 로그인 실패: ${signIn.error.message}`);

    // 본인이 직접 켜려고 하면 여전히 막혀야 한다(기존 트리거, 이번 변경과 무관)
    const selfAttempt = await clientA
      .from("accounts")
      .update({ pg_checkout_override: true })
      .eq("id", accountIdA)
      .select("pg_checkout_override");
    const blocked = !!selfAttempt.error || (selfAttempt.data ?? []).length === 0;
    expect(blocked).toBe(true);

    // admin(service_role)은 여전히 지정할 수 있어야 한다
    const adminAttempt = await admin
      .from("accounts")
      .update({ pg_checkout_override: true })
      .eq("id", accountIdA)
      .select("pg_checkout_override");
    if (adminAttempt.error) throw new Error(`admin의 pg_checkout_override 지정 실패: ${adminAttempt.error.message}`);
    expect(adminAttempt.data?.[0]?.pg_checkout_override).toBe(true);

    await admin.from("accounts").update({ pg_checkout_override: false }).eq("id", accountIdA);
  });

  it("H: 타인의 accounts row는 어떤 필드든 여전히 수정할 수 없다(행 단위 RLS, 기존 동작 회귀 없음)", async () => {
    const clientB: SupabaseClient = createClient(url, anonKey);
    const signIn = await clientB.auth.signInWithPassword({ email: emailB, password });
    if (signIn.error) throw new Error(`B 로그인 실패: ${signIn.error.message}`);

    const attempt = await clientB
      .from("accounts")
      .update({ name: "해킹시도" })
      .eq("id", accountIdA) // B가 A의 행을 수정 시도
      .select("id");
    const blocked = !!attempt.error || (attempt.data ?? []).length === 0;
    expect(blocked).toBe(true);

    const verify = await getFixtureAdminClient().from("accounts").select("name").eq("id", accountIdA).single();
    expect(verify.data?.name).not.toBe("해킹시도");
  });
});
