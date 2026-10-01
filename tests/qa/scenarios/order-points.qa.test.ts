/*
  QA 시나리오 — 주문 포인트 생명주기: 사용(차감) → 취소/전체 환불 시 정확히 1회 복원 → 중복/변조/재확정 방어.
  - 실행: npm run qa:production:points (QA_TARGET_PROJECT_REF / QA_PRODUCTION_ACK=1 필요). add: fix_order_point_lifecycle.sql 적용 후에만 의미가 있다.
  - 앱 경로: 회원 createOrder + usePoints(checkout direct 분기와 같은 순서) → 회원 updateOrderStatus('cancelled')(app/purchases) /
    QA 매니저 updateOrderStatus('cancelled'|'done')(app/manager/orders) / 회원 requestRefund(refund_membership).
  - 포인트 원장(point_transactions)은 append-only: 기존 행을 UPDATE/DELETE하지 않고, QA 시드는 이번 실행 전용 +행으로만 만든다.
  - QA 센터 안에서만, 이번 실행이 만든 UUID(주문/원장/결제/수강권/쿠폰)로만 정리한다.
*/
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cancelMyPendingOrderQuietly, createOrder, updateOrderStatus } from "../../../lib/orders";
import { requestRefund } from "../../../lib/mypage";
import { fetchMyPoints, usePoints } from "../../../lib/reviews";
import { getFixtureAdminClient, signOutTestSession, switchToTestUser } from "../../integration/setup";
import { bootstrapQa } from "../fixtures/bootstrap";
import { createQaPassProduct } from "../fixtures/catalog";
import { createAndIssueQaCoupon } from "../fixtures/coupons";
import { buildCouponOrderInput, buildDirectOrderInput } from "../fixtures/directOrder";
import { cleanupFixtures, createRunId, FixtureTracker, qaName, shouldKeepFailedFixtures } from "../runContext";
import type { QaFixtureState } from "../fixtures/center";

const PRICE = 50000;
const SEED = 20000;
const POINTS = 5000;

const admin = () => getFixtureAdminClient();
const tracker = new FixtureTracker(createRunId());
let state: QaFixtureState;
let product: { productId: string; name: string; price: number; totalCount: number };
let centerMemberId = "";
let failed = false;

const asMember = () => switchToTestUser("TEST_USER_A_EMAIL", "TEST_USER_A_PASSWORD");
const asManager = () => switchToTestUser("TEST_MANAGER_A_EMAIL", "TEST_MANAGER_A_PASSWORD");

async function balance(): Promise<number> {
  const { data, error } = await admin().from("point_transactions").select("amount").eq("center_id", state.centerId).eq("profile_id", state.memberProfileId);
  if (error) throw new Error(`포인트 원장 조회 실패: ${error.message}`);
  return (data ?? []).reduce((n, r: any) => n + (r.amount as number), 0);
}
async function ledger(orderId: string) {
  const { data, error } = await admin().from("point_transactions").select("id, amount, reason, order_id, reverses_id").eq("order_id", orderId).order("created_at");
  if (error) throw new Error(`주문 원장 조회 실패: ${error.message}`);
  for (const r of data ?? []) tracker.add("point_transactions", (r as any).id);
  return (data ?? []) as any[];
}
async function orderRow(id: string) {
  const { data, error } = await admin().from("orders").select("*").eq("id", id).single();
  if (error) throw new Error(`주문 조회 실패: ${error.message}`);
  return data as any;
}
async function paymentsForOrder(id: string) {
  const { data, error } = await admin().from("payments").select("*").eq("order_id", id);
  if (error) throw new Error(`결제 조회 실패: ${error.message}`);
  return (data ?? []) as any[];
}
async function membershipsForOrderProfile() {
  const { data, error } = await admin().from("memberships").select("id, status, remaining_count").eq("product_id", product.productId).eq("profile_id", state.memberProfileId);
  if (error) throw new Error(`수강권 조회 실패: ${error.message}`);
  return (data ?? []) as any[];
}

// 회원이 앱 checkout direct 분기와 같은 순서로 주문 생성 → 포인트 사용
async function memberOrderWithPoints(points: number, opts?: { memberCouponId?: string; discount?: number }): Promise<string> {
  await asMember();
  const base = { centerId: state.centerId, productId: product.productId, productName: product.name, price: PRICE };
  const amount = PRICE - (opts?.discount ?? 0) - points;
  const input = opts?.memberCouponId
    ? { ...buildCouponOrderInput({ ...base, discountAmount: opts.discount ?? 0, memberCouponId: opts.memberCouponId, amount }), pointsUsed: points }
    : { ...buildDirectOrderInput(base), amount, pointsUsed: points };
  const id = await createOrder(input as any);
  tracker.add("orders", id);
  if (points > 0) await usePoints(state.centerId, points, id);
  return id;
}
const rowsOf = (rows: any[], kind: "debit" | "restore") => rows.filter((r) => (kind === "debit" ? r.amount < 0 : r.amount > 0));

describe("QA: 주문 포인트 사용/복원 생명주기", () => {
  beforeAll(async () => {
    ({ state } = await bootstrapQa());
    product = await createQaPassProduct(admin(), tracker, state.centerId, { price: PRICE, totalCount: 10 });
    const cm = await admin().from("center_members").select("id").eq("center_id", state.centerId).eq("profile_id", state.memberProfileId).single();
    if (cm.error || !cm.data) throw new Error(`QA 회원의 center_members 조회 실패: ${cm.error?.message}`);
    centerMemberId = cm.data.id as string;
    // 이번 실행 전용 포인트 시드(+행 추가만, 기존 잔액/행은 수정하지 않는다)
    const seed = await admin().from("point_transactions").insert({
      profile_id: state.memberProfileId, center_id: state.centerId, amount: SEED, reason: qaName(tracker.runId, "포인트 시드"),
    }).select("id").single();
    if (seed.error || !seed.data) throw new Error(`QA 포인트 시드 실패: ${seed.error?.message}`);
    tracker.add("point_transactions", seed.data.id);
  });

  afterAll(async () => {
    const keep = shouldKeepFailedFixtures(process.env, failed);
    // 이번 실행의 주문에 묶인 원장 행(+복원 행)을 모두 기록한 뒤 정리한다
    for (const id of tracker.list("orders")) await ledger(id).catch(() => undefined);
    const res = await cleanupFixtures(admin(), tracker, { keep });
    if (keep) console.warn(`[QA] QA_KEEP_FAILED_FIXTURES=1 — 실패한 fixture를 보존했어요(runId ${tracker.runId}, ${tracker.total()}개)`);
    if (res.failures.length > 0) console.warn(`[QA] 정리 중 일부 실패: ${res.failures.join(" | ")}`);
    await signOutTestSession();
  });

  const step = (name: string, fn: () => Promise<void>) => it(name, async () => {
    try { await fn(); } catch (e) { failed = true; throw e; }
  });

  let orderA = "";
  step("CASE 1 — 회원 pending direct 주문 취소: 차감 -5,000 → 취소 → +5,000 복원, 수강권/결제 없음", async () => {
    const before = await balance();
    expect(before).toBe(SEED);
    orderA = await memberOrderWithPoints(POINTS);
    const rows = await ledger(orderA);
    expect(rowsOf(rows, "debit")).toHaveLength(1);
    expect(rowsOf(rows, "debit")[0]).toMatchObject({ amount: -POINTS, reason: "결제 시 사용", order_id: orderA, reverses_id: null });
    expect(await balance()).toBe(before - POINTS);
    expect(await fetchMyPoints(state.centerId)).toBe(before - POINTS);   // 앱이 보여주는 잔액

    await updateOrderStatus(orderA, "cancelled");   // app/purchases 회원 취소 경로
    expect((await orderRow(orderA)).status).toBe("cancelled");
    const after = await ledger(orderA);
    expect(rowsOf(after, "debit")).toHaveLength(1);   // 원본 차감 행은 그대로(append-only)
    expect(rowsOf(after, "restore")).toHaveLength(1);
    expect(rowsOf(after, "restore")[0]).toMatchObject({ amount: POINTS, reverses_id: rowsOf(after, "debit")[0].id, reason: "주문 취소 포인트 복원" });
    expect(await balance()).toBe(before);
    expect(await paymentsForOrder(orderA)).toHaveLength(0);
    expect(await membershipsForOrderProfile()).toHaveLength(0);
  });

  step("CASE 2 — 중복 취소(순차/동시): 추가 복원 행 없음, 잔액 변화 없음", async () => {
    const before = await balance();
    await expect(updateOrderStatus(orderA, "cancelled")).rejects.toThrow();   // 이미 취소 → 0행(RLS) 또는 가드
    await Promise.allSettled([updateOrderStatus(orderA, "cancelled"), updateOrderStatus(orderA, "cancelled")]);
    expect(rowsOf(await ledger(orderA), "restore")).toHaveLength(1);
    expect(await balance()).toBe(before);
  });

  step("CASE 3 — 관리자 취소: 회원 취소와 같은 복원", async () => {
    const before = await balance();
    const id = await memberOrderWithPoints(POINTS);
    expect(await balance()).toBe(before - POINTS);
    await asManager();
    await updateOrderStatus(id, "cancelled");   // app/manager/orders handleCancel
    expect((await orderRow(id)).status).toBe("cancelled");
    const rows = await ledger(id);
    expect(rowsOf(rows, "restore")).toHaveLength(1);
    expect(rowsOf(rows, "restore")[0].amount).toBe(POINTS);
    expect(await balance()).toBe(before);
    await updateOrderStatus(id, "cancelled").catch(() => undefined);   // 재호출해도 그대로
    expect(rowsOf(await ledger(id), "restore")).toHaveLength(1);
    expect(await balance()).toBe(before);
  });

  let orderD = "";
  let membershipD = "";
  step("CASE 4 — 구매 확정: 포인트는 복원되지 않고 수강권/결제가 정상 발급", async () => {
    const before = await balance();
    orderD = await memberOrderWithPoints(POINTS);
    await asManager();
    const result = await updateOrderStatus(orderD, "done");
    expect(result?.membershipId).toBeTruthy();
    membershipD = result!.membershipId as string;
    tracker.add("memberships", membershipD);
    expect(await balance()).toBe(before - POINTS);
    const rows = await ledger(orderD);
    expect(rowsOf(rows, "debit")).toHaveLength(1);
    expect(rowsOf(rows, "restore")).toHaveLength(0);
    const ps = await paymentsForOrder(orderD);
    expect(ps).toHaveLength(1);
    tracker.add("payments", ps[0].id);
    expect(ps[0].total_amount).toBe(PRICE - POINTS);   // 현재 정의: total_amount = 실제 결제액(포인트 제외)
  });

  step("CASE 5 — 전체 셀프 환불(쿠폰 10,000 + 포인트 5,000): 환불금 35,000, 쿠폰 available, 포인트 +5,000만 복원", async () => {
    await asManager();
    const { couponId, memberCouponId } = await createAndIssueQaCoupon(admin(), tracker, {
      centerId: state.centerId, centerMemberId, label: "포인트+쿠폰 환불", discountValue: 10000, minimumOrderAmount: 30000, productIds: [product.productId],
    });
    expect(couponId).toBeTruthy();
    const before = await balance();
    const id = await memberOrderWithPoints(POINTS, { memberCouponId, discount: 10000 });
    expect((await orderRow(id)).amount).toBe(35000);
    await asManager();
    const result = await updateOrderStatus(id, "done");
    const membershipId = result!.membershipId as string;
    tracker.add("memberships", membershipId);
    const ps = await paymentsForOrder(id);
    expect(ps).toHaveLength(1);
    tracker.add("payments", ps[0].id);
    expect(ps[0].total_amount).toBe(35000);
    expect(await balance()).toBe(before - POINTS);

    await asMember();
    await requestRefund(membershipId);
    const { data: mem } = await admin().from("memberships").select("status").eq("id", membershipId).single();
    expect(mem?.status).toBe("refunded");
    const { data: refunds } = await admin().from("payments").select("id, total_amount, sale_type").eq("membership_id", membershipId).eq("sale_type", "refund");
    expect(refunds ?? []).toHaveLength(1);
    tracker.add("payments", (refunds as any[])[0].id);
    expect((refunds as any[])[0].total_amount).toBe(-35000);   // 쿠폰 할인/포인트가 아닌 실제 결제금액만 환불
    const { data: mc } = await admin().from("member_coupons").select("status, order_id").eq("id", memberCouponId).single();
    expect(mc).toMatchObject({ status: "available", order_id: null });
    const rows = await ledger(id);
    expect(rowsOf(rows, "restore")).toHaveLength(1);
    expect(rowsOf(rows, "restore")[0]).toMatchObject({ amount: POINTS, reason: "환불 포인트 복원" });
    expect(await balance()).toBe(before);   // +5,000만(쿠폰 10,000원을 포인트로 돌려주지 않음)

    // CASE 6 — 중복 환불
    await expect(requestRefund(membershipId)).rejects.toThrow();
    expect(rowsOf(await ledger(id), "restore")).toHaveLength(1);
    expect(await balance()).toBe(before);
  });

  step("CASE 7 — 변조: points_used만 주장(차감 원장 없음)하면 취소 시 복원되지 않고 확정도 거부", async () => {
    await asMember();
    const before = await balance();
    const claimed = await createOrder({ ...buildDirectOrderInput({ centerId: state.centerId, productId: product.productId, productName: product.name, price: PRICE }), amount: PRICE - 3000, pointsUsed: 3000 } as any);
    tracker.add("orders", claimed);
    await asManager();
    await expect(updateOrderStatus(claimed, "done")).rejects.toThrow();   // 서버 검증: 포인트 사용 내역 미확인
    expect((await orderRow(claimed)).status).toBe("pending");
    await updateOrderStatus(claimed, "cancelled");
    expect(await ledger(claimed)).toHaveLength(0);
    expect(await balance()).toBe(before);   // 없던 포인트가 생기지 않는다
  });

  step("CASE 8 — cancelled 주문 재확정 금지: 발급/결제 없음, 취소된 주문은 되살릴 수 없음", async () => {
    await asManager();
    const before = await balance();
    const membershipsBefore = (await membershipsForOrderProfile()).length;
    await expect(updateOrderStatus(orderA, "done")).rejects.toThrow(/취소된 주문/);
    expect((await orderRow(orderA)).status).toBe("cancelled");
    expect(await paymentsForOrder(orderA)).toHaveLength(0);
    expect((await membershipsForOrderProfile()).length).toBe(membershipsBefore);
    // 발급된 주문을 취소로 바꾸는 시도도 상태 전이 가드가 거부한다(환불은 refund_membership 경로)
    await asManager();
    await expect(updateOrderStatus(orderD, "cancelled")).rejects.toThrow();   // done → cancelled 금지
    expect((await orderRow(orderD)).status).toBe("done");
    expect(await balance()).toBe(before);
  });

  step("CASE 9 — use_points 동일 주문 중복 호출: 차감은 1행, 잔액은 한 번만 감소 / 취소 시 한 번만 복원", async () => {
    await asMember();
    const before = await balance();
    const id = await memberOrderWithPoints(4000);
    await usePoints(state.centerId, 4000, id);   // 같은 주문에 다시 호출
    await Promise.allSettled([usePoints(state.centerId, 4000, id), usePoints(state.centerId, 4000, id)]);
    expect(rowsOf(await ledger(id), "debit")).toHaveLength(1);
    expect(await balance()).toBe(before - 4000);
    await expect(usePoints(state.centerId, 1000, id)).rejects.toThrow();   // 주문의 points_used와 다른 금액은 거부
    await updateOrderStatus(id, "cancelled");
    expect(rowsOf(await ledger(id), "restore")).toHaveLength(1);
    expect(await balance()).toBe(before);
  });

  step("CASE 10 — PG 실패/취소 정리 경로(cancelMyPendingOrderQuietly): pending만 취소·복원, 발급된 주문은 건드리지 않음", async () => {
    await asMember();
    const before = await balance();
    const id = await memberOrderWithPoints(POINTS);
    expect(await balance()).toBe(before - POINTS);
    expect(await cancelMyPendingOrderQuietly(id)).toBe(true);
    expect(await balance()).toBe(before);
    expect(await cancelMyPendingOrderQuietly(id)).toBe(false);   // 이미 취소 — 조용히 무시
    expect(rowsOf(await ledger(id), "restore")).toHaveLength(1);
    expect(await cancelMyPendingOrderQuietly(orderD)).toBe(false);   // 발급 완료(done)된 주문은 취소되지 않는다
    expect((await orderRow(orderD)).status).toBe("done");
  });

  step("다른 주문의 포인트 오염 없음: 이번 실행의 모든 복원 행은 자기 주문의 차감 행만 가리킨다", async () => {
    for (const id of tracker.list("orders")) {
      const rows = await ledger(id);
      const debitIds = new Set(rowsOf(rows, "debit").map((r) => r.id));
      for (const r of rowsOf(rows, "restore")) expect(debitIds.has(r.reverses_id)).toBe(true);
      expect(rowsOf(rows, "restore").length).toBeLessThanOrEqual(rowsOf(rows, "debit").length);
    }
  });
});
