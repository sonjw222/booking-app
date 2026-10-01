/*
  QA 시나리오 3 — 센터 쿠폰 적용 주문 → 서버 할인 검증 → 확정·발급 → 쿠폰 사용 처리 → 재사용/변조/잘못된 쿠폰 방어.
  - 실행: npm run qa:production:coupon (QA_TARGET_PROJECT_REF / QA_PRODUCTION_ACK=1 필요).
  - 앱의 실제 경로: 회원 createOrder(memberCouponId, checkout direct 분기와 같은 amount/discountAmount) → 관리자 updateOrderStatus('done') → RPC fulfill_order
    (공통 검증 _order_expected_amount: 상품 snapshot - 서버가 검증한 센터 쿠폰 - 포인트).
  - 현재 계약(코드/SQL로 확인): 주문 생성은 쿠폰을 검증·소비하지 않는다(쿠폰은 확정 전까지 available). 확정 시 서버가 쿠폰 소유/센터/유효기간/최소금액/적용대상/상태를
    검증해 할인액을 직접 계산하고, 주문 금액(amount)이 서버 계산값과 다르면 "보정"하지 않고 확정을 거부한다. 성공 시에만 쿠폰을 used + order_id로 소비한다.
  - QA 센터 안에서만, 이번 실행이 만든 UUID로만 정리한다.
*/
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOrder, updateOrderStatus } from "../../../lib/orders";
import { getFixtureAdminClient, signOutTestSession, switchToTestUser } from "../../integration/setup";
import { bootstrapQa } from "../fixtures/bootstrap";
import { createQaPassProduct } from "../fixtures/catalog";
import { createAndIssueQaCoupon } from "../fixtures/coupons";
import { buildCouponOrderInput } from "../fixtures/directOrder";
import { cleanupFixtures, createRunId, FixtureTracker, shouldKeepFailedFixtures } from "../runContext";
import type { QaFixtureState } from "../fixtures/center";

const PRICE = 50000;
const DISCOUNT = 10000;
const FINAL = PRICE - DISCOUNT;

const admin = () => getFixtureAdminClient();
const tracker = new FixtureTracker(createRunId());
let state: QaFixtureState;
let main: { productId: string; name: string; price: number; totalCount: number };
let other: { productId: string; name: string; price: number; totalCount: number };
let centerMemberId = "";
const coupons: Record<"c1" | "c2" | "c3", { couponId: string; memberCouponId: string }> = {} as any;
let orderA = "";
let orderB = "";
let membershipA = "";
let failed = false;

async function orderRow(id: string) {
  const { data, error } = await admin().from("orders").select("*").eq("id", id).single();
  if (error) throw new Error(`주문 조회 실패: ${error.message}`);
  return data as any;
}
async function couponRow(id: string) {
  const { data, error } = await admin().from("member_coupons").select("id, status, used_at, order_id, coupon_id").eq("id", id).single();
  if (error) throw new Error(`지급 쿠폰 조회 실패: ${error.message}`);
  return data as any;
}
async function membershipsForMainProduct() {
  const { data, error } = await admin().from("memberships").select("id, total_count, remaining_count, product_id, profile_id, center_id, status")
    .eq("product_id", main.productId).eq("profile_id", state.memberProfileId);
  if (error) throw new Error(`수강권 조회 실패: ${error.message}`);
  return (data ?? []) as any[];
}
async function paymentsForOrder(id: string) {
  const { data, error } = await admin().from("payments").select("*").eq("order_id", id);
  if (error) throw new Error(`결제 조회 실패: ${error.message}`);
  return (data ?? []) as any[];
}
async function memberCreatesOrder(memberCouponId: string, overrides?: { amount?: number; discountAmount?: number; productId?: string; productName?: string }) {
  await switchToTestUser("TEST_USER_A_EMAIL", "TEST_USER_A_PASSWORD");
  const id = await createOrder(buildCouponOrderInput({
    centerId: state.centerId, productId: overrides?.productId ?? main.productId, productName: overrides?.productName ?? main.name,
    price: PRICE, discountAmount: overrides?.discountAmount ?? DISCOUNT, memberCouponId, amount: overrides?.amount,
  }));
  tracker.add("orders", id);
  return id;
}
async function managerConfirms(orderId: string) {
  await switchToTestUser("TEST_MANAGER_A_EMAIL", "TEST_MANAGER_A_PASSWORD");
  return updateOrderStatus(orderId, "done");
}

describe("QA: 센터 쿠폰 주문 → 서버 검증 → 발급 → 사용 처리 → 방어", () => {
  beforeAll(async () => {
    ({ state } = await bootstrapQa());
    main = await createQaPassProduct(admin(), tracker, state.centerId, { price: PRICE, totalCount: 10 });
    other = await createQaPassProduct(admin(), tracker, state.centerId, { price: 30000, totalCount: 5 });
    const cm = await admin().from("center_members").select("id").eq("center_id", state.centerId).eq("profile_id", state.memberProfileId).single();
    if (cm.error || !cm.data) throw new Error(`QA 회원의 center_members 조회 실패: ${cm.error?.message}`);
    centerMemberId = cm.data.id as string;
    // 쿠폰 생성/지급은 앱 경로(QA 매니저 세션)로: 정액 10,000원, 최소 주문금액 30,000원, 이번 상품만 적용
    await switchToTestUser("TEST_MANAGER_A_EMAIL", "TEST_MANAGER_A_PASSWORD");
    const base = { centerId: state.centerId, centerMemberId, discountValue: DISCOUNT, minimumOrderAmount: 30000 };
    coupons.c1 = await createAndIssueQaCoupon(admin(), tracker, { ...base, label: "쿠폰 정상 사용", productIds: [main.productId] });
    coupons.c2 = await createAndIssueQaCoupon(admin(), tracker, { ...base, label: "쿠폰 금액 변조 방어", productIds: [main.productId] });
    coupons.c3 = await createAndIssueQaCoupon(admin(), tracker, { ...base, label: "쿠폰 다른 상품 전용", productIds: [other.productId] });
  });

  afterAll(async () => {
    const keep = shouldKeepFailedFixtures(process.env, failed);
    const res = await cleanupFixtures(admin(), tracker, { keep });
    if (keep) console.warn(`[QA] QA_KEEP_FAILED_FIXTURES=1 — 실패한 fixture를 보존했어요(runId ${tracker.runId}, ${tracker.total()}개)`);
    if (res.failures.length > 0) console.warn(`[QA] 정리 중 일부 실패: ${res.failures.join(" | ")}`);
    await signOutTestSession();
  });

  const step = (name: string, fn: () => Promise<void>) => it(name, async () => {
    try { await fn(); } catch (e) { failed = true; throw e; }
  });

  step("1. 시작 상태: 지급된 쿠폰 3장 모두 available(사용 기록 없음)", async () => {
    for (const k of ["c1", "c2", "c3"] as const) {
      expect(await couponRow(coupons[k].memberCouponId)).toMatchObject({ status: "available", used_at: null, order_id: null });
    }
  });

  step("2. QA 회원이 쿠폰을 골라 주문(checkout direct와 같은 amount/discountAmount/memberCouponId) → 확정 전 상태", async () => {
    orderA = await memberCreatesOrder(coupons.c1.memberCouponId);
    const o = await orderRow(orderA);
    expect(o).toMatchObject({
      pay_method: "direct", status: "pending", payment_provider: null, member_coupon_id: coupons.c1.memberCouponId,
      amount: FINAL, discount_amount: DISCOUNT, points_used: 0, product_id: main.productId, profile_id: state.memberProfileId,
    });
    expect(o.product_amount_snapshot).toBe(PRICE);          // 서버가 확정한 원 상품가(할인 전)
    expect(await membershipsForMainProduct()).toHaveLength(0);
    expect(await paymentsForOrder(orderA)).toHaveLength(0);
    // 현재 정책: 주문 생성 시에는 쿠폰을 예약/소비하지 않는다 — 확정 전까지 available
    expect(await couponRow(coupons.c1.memberCouponId)).toMatchObject({ status: "available", used_at: null, order_id: null });
  });

  step("3. 같은 쿠폰으로 두 번째 주문도 확정 전에는 만들어진다(재사용 방지는 확정 시점 서버 검증)", async () => {
    // orderB는 아래 5단계에서 사용 — 지금은 쿠폰이 아직 available이므로 주문 생성은 막히지 않는다
    orderB = await memberCreatesOrder(coupons.c1.memberCouponId);
    expect((await orderRow(orderB)).status).toBe("pending");
  });

  step("4. QA 매니저가 확정 → 서버가 할인 검증 후 발급: 수강권 1건, 결제 1건(할인 후 금액), 쿠폰 used + order_id 연결", async () => {
    const result = await managerConfirms(orderA);
    expect(result).toMatchObject({ alreadyDone: false });
    membershipA = result!.membershipId as string;
    tracker.add("memberships", membershipA);

    const o = await orderRow(orderA);
    expect(o).toMatchObject({ status: "done", amount: FINAL, discount_amount: DISCOUNT, member_coupon_id: coupons.c1.memberCouponId });
    expect(o.product_amount_snapshot).toBe(PRICE);            // 원 상품가 유지
    expect(o.paid_at).not.toBeNull();

    const ms = await membershipsForMainProduct();
    expect(ms).toHaveLength(1);
    expect(ms[0]).toMatchObject({ id: membershipA, total_count: 10, remaining_count: 10, center_id: state.centerId, status: "active" });

    const ps = await paymentsForOrder(orderA);
    expect(ps).toHaveLength(1);
    tracker.add("payments", ps[0].id);
    expect(ps[0]).toMatchObject({ membership_id: membershipA, total_amount: FINAL, direct_amount: FINAL, card_amount: 0, status: "paid" });
    expect(ps[0].total_amount).not.toBe(PRICE);               // 할인 전 금액을 결제로 기록하지 않음

    const mc = await couponRow(coupons.c1.memberCouponId);
    expect(mc).toMatchObject({ status: "used", order_id: orderA });
    expect(mc.used_at).not.toBeNull();
  });

  step("5. 재사용 방지: 이미 사용된 같은 쿠폰의 두 번째 주문 확정은 거부 — 추가 수강권/결제 없음, 쿠폰·첫 주문 상태 유지", async () => {
    const before = await couponRow(coupons.c1.memberCouponId);
    await expect(managerConfirms(orderB)).rejects.toThrow(/사용할 수 없는 쿠폰/);
    expect((await orderRow(orderB)).status).toBe("pending");
    expect(await paymentsForOrder(orderB)).toHaveLength(0);
    expect(await membershipsForMainProduct()).toHaveLength(1);
    const after = await couponRow(coupons.c1.memberCouponId);
    expect(after).toMatchObject({ status: "used", order_id: orderA });
    expect(after.used_at).toBe(before.used_at);
    expect((await orderRow(orderA)).status).toBe("done");
    expect(await paymentsForOrder(orderA)).toHaveLength(1);
  });

  step("5-b. 사용 완료 후 새로 만든 세 번째 주문도 확정 시 거부(재사용 방지)", async () => {
    const orderC = await memberCreatesOrder(coupons.c1.memberCouponId);
    await expect(managerConfirms(orderC)).rejects.toThrow(/사용할 수 없는 쿠폰/);
    expect(await membershipsForMainProduct()).toHaveLength(1);
    expect(await paymentsForOrder(orderC)).toHaveLength(0);
    expect(await couponRow(coupons.c1.memberCouponId)).toMatchObject({ status: "used", order_id: orderA });
  });

  step("6. 클라이언트 금액/할인 변조 방어: 서버 계산 금액과 다르면 보정하지 않고 확정 거부(쿠폰은 소비되지 않음)", async () => {
    // (a) 할인을 적용하지 않은 금액(50,000)으로 주문 — 쿠폰을 쓰면서 할인 없이 결제하려는 변조
    const noDiscount = await memberCreatesOrder(coupons.c2.memberCouponId, { amount: PRICE, discountAmount: 0 });
    // (b) 서버 할인(10,000)보다 큰 임의 할인(30,000)을 주장
    const overDiscount = await memberCreatesOrder(coupons.c2.memberCouponId, { amount: PRICE - 30000, discountAmount: 30000 });
    for (const id of [noDiscount, overDiscount]) {
      await expect(managerConfirms(id)).rejects.toThrow(/서버 계산 금액/);
      expect((await orderRow(id)).status).toBe("pending");
      expect(await paymentsForOrder(id)).toHaveLength(0);
    }
    expect(await membershipsForMainProduct()).toHaveLength(1);                       // 변조 주문으로 수강권이 늘지 않음
    expect(await couponRow(coupons.c2.memberCouponId)).toMatchObject({ status: "available", used_at: null, order_id: null });   // 쿠폰 미소비
  });

  step("7. 잘못된 쿠폰 방어: 다른 상품 전용 쿠폰을 이 상품에 쓰면 확정 거부(수강권/결제/쿠폰 상태 변화 없음)", async () => {
    const wrong = await memberCreatesOrder(coupons.c3.memberCouponId);
    await expect(managerConfirms(wrong)).rejects.toThrow(/이 수강권에는 사용할 수 없는 쿠폰/);
    expect((await orderRow(wrong)).status).toBe("pending");
    expect(await paymentsForOrder(wrong)).toHaveLength(0);
    expect(await membershipsForMainProduct()).toHaveLength(1);
    expect(await couponRow(coupons.c3.memberCouponId)).toMatchObject({ status: "available", used_at: null, order_id: null });
  });

  step("알림은 QA 센터의 QA 계정에게만 생성된다(일반 사용자 fan-out 없음)", async () => {
    const { data: mgr } = await admin().from("manager_centers").select("account_id").eq("center_id", state.centerId).eq("status", "active");
    const allowed = new Set<string>([state.memberAccountId, ...(mgr ?? []).map((m: any) => m.account_id as string)]);
    const { data, error } = await admin().from("notifications").select("recipient_account_id").eq("center_id", state.centerId);
    expect(error).toBeNull();
    for (const n of data ?? []) expect(allowed.has((n as any).recipient_account_id)).toBe(true);
  });
});
