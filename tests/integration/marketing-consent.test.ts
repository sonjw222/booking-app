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
import { getFixtureAdminClient, requireEnv } from "./setup";

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
