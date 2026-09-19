/*
  Web QA P2 Fix Batch(2026-09-19) — P2-45 회귀 테스트.

  QA 1차 패스에서 확인된 근본 원인: registerPayment()(lib/sales.ts)가 환불
  (sale_type='refund')일 때 total_amount만 음수로 저장하고 card_amount 등
  결제수단별 컬럼은 계속 양수로 저장해, "결제수단별" 합계(summarize()의
  byMethod)가 환불을 반영하지 못해 "총 매출"(totalSales)과 항상 어긋났다.
  fetchPayments()도 manager_dashboard_summary() RPC와 달리 mock 결제
  (payment_provider='mock')를 제외하지 않아, 같은 기간의 두 화면(홈 대시보드 vs
  매출 페이지) 총액이 어긋나는 원인이 하나 더 있었다.

  이 파일은 그 두 가지를 직접 재현·검증한다 — "버그가 다시 생기면 이 테스트가
  먼저 깨진다"는 회귀 테스트 목적. 기존 43개 파일이 공유하는 managerA 소유
  "통합테스트센터-%"를 그대로 쓰되(별도 신규 센터를 만들지 않음 — sales 집계는
  센터 격리와 무관해 새 센터가 필요 없음), 이 파일이 만든 payments 행만 memo
  태그로 구분해 afterAll에서 정리한다.
*/
import { afterAll, describe, expect, it } from "vitest";
import { registerPayment, fetchPayments, summarize } from "../../../lib/sales";
import { getOrCreateOwnedTestCenter, getFixtureAdminClient } from "../setup";
import { managerA as loginManagerA, memberA as loginMemberA } from "./actors";
import { runScenario } from "./reporter";

function newRunId(): string {
  return `qa_p2_45_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

describe("P2-45 매출 표시 불일치 — 환불 부호 정합성 + mock 결제 제외 (fix regression)", () => {
  const runId = newRunId();
  const memoTag1 = `${runId}_a`;
  const memoTag2 = `${runId}_b`;

  afterAll(async () => {
    const admin = getFixtureAdminClient();
    await admin.from("payments").delete().in("memo", [memoTag1, memoTag2]);
  }, 30000);

  it("환불 결제는 카드/현금 등 결제수단 컬럼도 total_amount와 같은 부호(음수)로 저장되고, byMethod 합계가 총 매출과 일치한다", async () => {
    // registerPayment()는 RLS가 걸린 일반 insert라 "현재 로그인된" 계정 기준으로
    // 권한이 판정된다 — memberA를 먼저 로그인해 profileId만 얻어두고, 실제
    // registerPayment() 호출 시점엔 managerA로 다시 전환해(같은 supabase 싱글턴을
    // 두 계정이 순서대로 공유 — tests/integration/setup.ts 상단 설명 참고) 매니저
    // 권한으로 결제가 등록되게 한다.
    const memberA = await loginMemberA();
    const memberProfileId = memberA.profileId;
    const managerA = await loginManagerA();
    const centerId = await getOrCreateOwnedTestCenter(managerA);
    const paidAt = new Date().toISOString().slice(0, 10);

    await runScenario("SCN-P2-45-01", ["manager(centerA)"], async (assertions) => {
      // 신규결제 카드 50,000원
      await registerPayment({
        centerId, profileId: memberProfileId, saleType: "new",
        cardAmount: 50000, cashAmount: 0, transferAmount: 0, pointAmount: 0,
        unpaidAmount: 0, paidAt, memo: memoTag1,
      });
      // 같은 회원, 카드로 20,000원 환불
      await registerPayment({
        centerId, profileId: memberProfileId, saleType: "refund",
        cardAmount: 20000, cashAmount: 0, transferAmount: 0, pointAmount: 0,
        unpaidAmount: 0, paidAt, memo: memoTag1,
      });

      const admin = getFixtureAdminClient();
      const { data: refundRow, error } = await admin
        .from("payments")
        .select("card_amount, total_amount")
        .eq("memo", memoTag1)
        .eq("sale_type", "refund")
        .single();
      if (error || !refundRow) throw new Error(`환불 결제 조회 실패: ${error?.message ?? "no data"}`);

      assertions.push({
        name: "환불 행의 card_amount가 음수로 저장됨(total_amount와 부호 일치)",
        passed: (refundRow as any).card_amount === -20000 && (refundRow as any).total_amount === -20000,
        detail: JSON.stringify(refundRow),
      });
      expect((refundRow as any).card_amount).toBe(-20000);
      expect((refundRow as any).total_amount).toBe(-20000);

      const rows = await fetchPayments(centerId, paidAt, paidAt);
      const tagged = rows.filter((r) => r.memo === memoTag1);
      const summary = summarize(tagged);

      assertions.push({
        name: "byMethod.card(30,000)이 totalSales(30,000)와 일치 — 환불이 결제수단별 합계에도 반영됨",
        passed: summary.byMethod.card === 30000 && summary.totalSales === 30000,
        detail: JSON.stringify(summary),
      });
      expect(summary.byMethod.card).toBe(30000);
      expect(summary.totalSales).toBe(30000);
    });
  }, 30000);

  it("mock 결제(payment_provider='mock')는 fetchPayments() 집계에서 제외된다", async () => {
    const memberA = await loginMemberA();
    const memberProfileId = memberA.profileId;
    const managerA = await loginManagerA();
    const centerId = await getOrCreateOwnedTestCenter(managerA);
    const paidAt = new Date().toISOString().slice(0, 10);
    const admin = getFixtureAdminClient();

    await runScenario("SCN-P2-45-02", ["manager(centerA)"], async (assertions) => {
      await registerPayment({
        centerId, profileId: memberProfileId, saleType: "new",
        cardAmount: 10000, cashAmount: 0, transferAmount: 0, pointAmount: 0,
        unpaidAmount: 0, paidAt, memo: memoTag2,
      });
      const { error: mockErr } = await admin.from("payments").insert({
        center_id: centerId, profile_id: memberProfileId, sale_type: "new",
        revenue_category: "membership", card_amount: 999000, cash_amount: 0,
        transfer_amount: 0, point_amount: 0, total_amount: 999000,
        unpaid_amount: 0, paid_at: paidAt, memo: memoTag2, status: "paid",
        payment_provider: "mock",
      });
      if (mockErr) throw new Error(`mock 결제 삽입 실패: ${mockErr.message}`);

      const rows = await fetchPayments(centerId, paidAt, paidAt);
      const tagged = rows.filter((r) => r.memo === memoTag2);
      const summary = summarize(tagged);

      assertions.push({
        name: "mock 결제(999,000원)가 집계에서 빠지고 실결제(10,000원)만 잡힘",
        passed: summary.totalSales === 10000,
        detail: JSON.stringify({ totalSales: summary.totalSales, taggedCount: tagged.length }),
      });
      expect(summary.totalSales).toBe(10000);
    });
  }, 30000);
});
