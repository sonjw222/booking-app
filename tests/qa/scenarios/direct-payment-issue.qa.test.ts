/*
  QA 시나리오 2 — 회원 직접결제 주문 생성 → 확정 전(미발급) → QA 매니저 결제 확정 → 수강권 정확히 1개 발급(+중복 확정 방지).
  - 실행: npm run qa:production:direct-payment (QA_TARGET_PROJECT_REF / QA_PRODUCTION_ACK=1 필요). 쿠폰은 사용하지 않는다(쿠폰 QA는 별도 시나리오).
  - 앱이 실제로 쓰는 경로: 회원 lib/orders.ts createOrder(app/checkout direct 분기) → 관리자 fetchCenterOrders/updateOrderStatus('done')(app/manager/orders handleDone) → RPC fulfill_order.
  - QA 센터 안에서만, 이번 실행이 만든 UUID로만 정리한다.
*/
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOrder, fetchCenterOrders, updateOrderStatus } from "../../../lib/orders";
import { getFixtureAdminClient, signOutTestSession, switchToTestUser } from "../../integration/setup";
import { bootstrapQa } from "../fixtures/bootstrap";
import { createQaPassProduct } from "../fixtures/catalog";
import { buildDirectOrderInput } from "../fixtures/directOrder";
import { cleanupFixtures, createRunId, FixtureTracker, shouldKeepFailedFixtures } from "../runContext";
import type { QaFixtureState } from "../fixtures/center";

const admin = () => getFixtureAdminClient();
const tracker = new FixtureTracker(createRunId());
const startedAt = new Date(Date.now() - 5000).toISOString();
let state: QaFixtureState;
let product: { productId: string; name: string; price: number; totalCount: number };
let orderId = "";
let membershipId = "";
let failed = false;

async function orderRow() {
  const { data, error } = await admin().from("orders").select("*").eq("id", orderId).single();
  if (error) throw new Error(`주문 조회 실패: ${error.message}`);
  return data as any;
}
async function membershipsForProduct() {
  const { data, error } = await admin().from("memberships").select("id, product_id, profile_id, center_id, total_count, remaining_count, status")
    .eq("product_id", product.productId).eq("profile_id", state.memberProfileId);
  if (error) throw new Error(`수강권 조회 실패: ${error.message}`);
  return (data ?? []) as any[];
}
async function paymentsForOrder() {
  const { data, error } = await admin().from("payments").select("*").eq("order_id", orderId);
  if (error) throw new Error(`결제 조회 실패: ${error.message}`);
  return (data ?? []) as any[];
}

describe("QA: 직접결제 주문 → 관리자 확정·발급", () => {
  beforeAll(async () => {
    ({ state } = await bootstrapQa());   // QA 회원 세션
    product = await createQaPassProduct(admin(), tracker, state.centerId, { price: 50000, totalCount: 10 });
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

  step("1. QA 회원이 앱의 direct 결제 경로(createOrder)로 주문 생성", async () => {
    orderId = await createOrder(buildDirectOrderInput({ centerId: state.centerId, productId: product.productId, productName: product.name, price: product.price }));
    tracker.add("orders", orderId);
    expect(orderId).toBeTruthy();
  });

  step("2. 확정 전: pay_method=direct, pending, 쿠폰/PG 없음, 수강권·결제 아직 없음", async () => {
    const o = await orderRow();
    expect(o).toMatchObject({
      pay_method: "direct", status: "pending", payment_provider: null, center_id: state.centerId, profile_id: state.memberProfileId,
      product_id: product.productId, amount: product.price, discount_amount: 0, points_used: 0, coupon_code: null, member_coupon_id: null,
      auto_book: false,
    });
    expect(o.product_amount_snapshot).toBe(product.price);   // 서버(트리거)가 확정한 상품 기본금액
    expect(o.selected_count).toBeNull();
    expect(o.paid_at).toBeNull();
    expect(await membershipsForProduct()).toHaveLength(0);
    expect(await paymentsForOrder()).toHaveLength(0);
    // 이 회원/센터에 이번 실행 이후 만들어진 결제(매출)도 없다
    const { data } = await admin().from("payments").select("id").eq("center_id", state.centerId).eq("profile_id", state.memberProfileId).gte("created_at", startedAt);
    expect(data ?? []).toHaveLength(0);
  });

  step("3~4. QA 매니저 세션: 관리자 주문 목록(fetchCenterOrders)에 pending으로 보이고, 확정·발급(updateOrderStatus 'done' → fulfill_order)", async () => {
    await switchToTestUser("TEST_MANAGER_A_EMAIL", "TEST_MANAGER_A_PASSWORD");
    const list = await fetchCenterOrders(state.centerId);
    const mine = list.find((o) => o.id === orderId);
    expect(mine?.status).toBe("pending");
    const result = await updateOrderStatus(orderId, "done");
    expect(result).toMatchObject({ alreadyDone: false, autoBookRequested: false });
    expect(result?.membershipId).toBeTruthy();
    membershipId = result!.membershipId as string;
    tracker.add("memberships", membershipId);
  });

  step("5. 확정 후: 주문 done, 수강권 정확히 1건(10/10), 결제 정확히 1건(직접결제 금액)", async () => {
    const o = await orderRow();
    expect(o.status).toBe("done");
    expect(o.paid_at).not.toBeNull();
    const ms = await membershipsForProduct();
    expect(ms).toHaveLength(1);
    expect(ms[0]).toMatchObject({ id: membershipId, product_id: product.productId, profile_id: state.memberProfileId, center_id: state.centerId, total_count: 10, remaining_count: 10, status: "active" });
    const ps = await paymentsForOrder();
    expect(ps).toHaveLength(1);
    tracker.add("payments", ps[0].id);
    expect(ps[0]).toMatchObject({
      center_id: state.centerId, profile_id: state.memberProfileId, membership_id: membershipId, total_amount: product.price,
      direct_amount: product.price, card_amount: 0, cash_amount: 0, transfer_amount: 0, status: "paid", sale_type: "new", revenue_category: "membership",
    });
  });

  step("6. 중복 확정(순차/동시)을 다시 호출해도 수강권·결제가 늘지 않는다", async () => {
    const again = await updateOrderStatus(orderId, "done");
    expect(again).toMatchObject({ alreadyDone: true, membershipId: null });
    const parallel = await Promise.allSettled([updateOrderStatus(orderId, "done"), updateOrderStatus(orderId, "done")]);
    for (const r of parallel) if (r.status === "fulfilled") expect(r.value).toMatchObject({ alreadyDone: true });
    expect(await membershipsForProduct()).toHaveLength(1);
    expect(await paymentsForOrder()).toHaveLength(1);
    expect((await orderRow()).status).toBe("done");
  });

  step("7. 쿠폰 미사용 계약: 이 주문에 센터 쿠폰 사용 기록이 없다", async () => {
    const { data, error } = await admin().from("member_coupons").select("id").eq("order_id", orderId);
    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(0);
  });

  step("알림은 QA 센터의 QA 계정에게만 생성된다", async () => {
    const { data: mgr } = await admin().from("manager_centers").select("account_id").eq("center_id", state.centerId).eq("status", "active");
    const allowed = new Set<string>([state.memberAccountId, ...(mgr ?? []).map((m: any) => m.account_id as string)]);
    const { data, error } = await admin().from("notifications").select("recipient_account_id").eq("center_id", state.centerId);
    expect(error).toBeNull();
    for (const n of data ?? []) expect(allowed.has((n as any).recipient_account_id)).toBe(true);
  });
});
