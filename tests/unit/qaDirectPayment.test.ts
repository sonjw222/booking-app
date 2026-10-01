/*
  Production QA 시나리오 2(직접결제 → 관리자 확정·발급) 코드 계약 — Production에 접근하지 않고 검증한다.
  앱의 실제 경로를 추적한 결과: app/checkout direct 분기 → lib/orders.createOrder(orders INSERT) → app/manager/orders handleDone →
  updateOrderStatus('done') → RPC fulfill_order.
*/
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildDirectOrderInput } from "../qa/fixtures/directOrder";
import { CLEANUP_ORDER } from "../qa/runContext";

const root = join(__dirname, "../..");
const read = (p: string) => readFileSync(join(root, p), "utf-8");
const sc = read("tests/qa/scenarios/direct-payment-issue.qa.test.ts");
const stripSql = (s: string) => s.replace(/--.*$/gm, "");

describe("앱의 실제 direct 주문/확정 경로(추측 없음)", () => {
  const checkout = read("app/checkout/page.tsx");
  const direct = checkout.slice(checkout.indexOf('if (effectivePayMethod === "direct") {'), checkout.indexOf("// 나머지(카드/카카오페이/토스페이/계좌이체)"));
  it("checkout direct 분기는 createOrder를 PG provider 없이 호출하고 pending 주문만 접수한다", () => {
    expect(direct).toContain("await createOrder({");
    expect(direct).toContain("payMethod: effectivePayMethod");
    expect(direct).not.toContain("provider:");
    expect(direct).toContain("setPendingManualPayment(true)");
  });
  it("direct 분기는 선택한 센터 쿠폰만 memberCouponId로 전달한다(미선택=undefined, 하드코딩 프로모 쿠폰 없음) — QA 시나리오는 쿠폰 키 자체를 넘기지 않는다", () => {
    expect(direct).toContain("memberCouponId: selectedMemberCouponId ?? undefined");
    expect(direct).not.toMatch(/couponCode:|WELCOME|FIGURE10/);
    const input = buildDirectOrderInput({ centerId: "c", productId: "p", productName: "n", price: 50000 });
    expect(Object.keys(input)).not.toContain("memberCouponId");
    expect(Object.keys(input)).not.toContain("couponCode");
    expect(input).toMatchObject({ payMethod: "direct", amount: 50000, discountAmount: 0, pointsUsed: 0, autoBook: false });
  });
  it("createOrder는 orders에 status=pending으로 INSERT하고 payment_provider를 provider 없으면 null로 둔다", () => {
    const lib = read("lib/orders.ts");
    expect(lib).toContain('status: "pending"');
    expect(lib).toContain("payment_provider: input.provider ?? null");
    expect(lib).toContain('supabase.from("orders").insert(row)');
  });
  it("관리자 주문 화면의 확정은 updateOrderStatus(o.id, 'done') → fulfill_order RPC", () => {
    expect(read("app/manager/orders/page.tsx")).toContain('await updateOrderStatus(o.id, "done")');
    expect(read("lib/orders.ts")).toContain('supabase.rpc("fulfill_order", { p_order_id: orderId })');
  });
  it("서버: fulfill_order는 이미 done이면 already_done으로 즉시 반환(주문 행 잠금)해 중복 발급을 막고, 결제를 order_id로 1건 기록한다", () => {
    const sql = stripSql(read("fix_order_issuance_and_auto_booking.sql"));
    expect(sql).toContain("select * into v_order from orders where id = p_order_id for update;");
    expect(sql).toContain("if v_order.status = 'done' then");
    expect(sql).toContain("return json_build_object('already_done', true);");
    expect(sql).toContain("center_id, profile_id, membership_id, order_id,");
    expect(sql).toContain("case when v_order.pay_method = 'direct' then v_order.amount else 0 end");
  });
});

describe("시나리오 계약: 생성 → 확정 전 → 확정 후 → 중복 확정", () => {
  it("회원 세션으로 createOrder, 매니저 세션으로 fetchCenterOrders/updateOrderStatus('done')를 같은 앱 함수로 호출", () => {
    expect(sc).toContain('import { createOrder, fetchCenterOrders, updateOrderStatus } from "../../../lib/orders"');
    expect(sc).toContain('switchToTestUser("TEST_MANAGER_A_EMAIL", "TEST_MANAGER_A_PASSWORD")');
    expect(sc.indexOf("await createOrder(")).toBeLessThan(sc.indexOf("await updateOrderStatus(orderId"));
    expect(sc.indexOf("switchToTestUser(")).toBeLessThan(sc.indexOf("fetchCenterOrders(state.centerId)"));
  });
  it("확정 전 검증: direct/pending/PG 없음/쿠폰 없음, 수강권 0건, 결제 0건(매출로 잘못 잡히지 않음)", () => {
    for (const s of ['pay_method: "direct"', 'status: "pending"', "payment_provider: null", "coupon_code: null", "member_coupon_id: null",
      "expect(await membershipsForProduct()).toHaveLength(0)", "expect(await paymentsForOrder()).toHaveLength(0)", "gte(\"created_at\", startedAt)"]) expect(sc).toContain(s);
  });
  it("확정 후 검증: 주문 done, 수강권 정확히 1건(10/10, product/profile/center), 결제 정확히 1건(직접결제 금액)", () => {
    for (const s of ['expect(o.status).toBe("done")', "expect(ms).toHaveLength(1)", "total_count: 10, remaining_count: 10",
      "expect(ps).toHaveLength(1)", "direct_amount: product.price", 'status: "paid"']) expect(sc).toContain(s);
  });
  it("중복 확정(순차 + 동시) 후에도 수강권/결제는 1건, already_done 반환", () => {
    expect(sc).toContain("alreadyDone: true, membershipId: null");
    expect(sc).toContain("Promise.allSettled([updateOrderStatus(orderId");
    const after = sc.slice(sc.indexOf("6. 중복 확정"));
    expect(after).toContain("expect(await membershipsForProduct()).toHaveLength(1)");
    expect(after).toContain("expect(await paymentsForOrder()).toHaveLength(1)");
  });
  it("쿠폰 사용 안 함 계약: 주문에 센터 쿠폰 사용 기록(member_coupons.order_id) 없음 + createOrder 입력에 쿠폰 키 없음", () => {
    expect(sc).toContain('from("member_coupons").select("id").eq("order_id", orderId)');
    expect(sc).not.toMatch(/memberCouponId|couponCode/);
  });
});

describe("cleanup 범위 / 안전장치 / 분리 실행", () => {
  it("정리는 tracker(이번 실행의 주문·결제·수강권·상품 UUID)로만, 결제→수강권→주문→상품 순서, QA 센터/계정은 건드리지 않음", () => {
    expect(CLEANUP_ORDER.indexOf("payments")).toBeLessThan(CLEANUP_ORDER.indexOf("memberships"));
    expect(CLEANUP_ORDER.indexOf("memberships")).toBeLessThan(CLEANUP_ORDER.indexOf("orders"));
    expect(CLEANUP_ORDER.indexOf("orders")).toBeLessThan(CLEANUP_ORDER.indexOf("products"));
    for (const s of ['tracker.add("orders", orderId)', 'tracker.add("memberships", membershipId)', 'tracker.add("payments", ps[0].id)', "cleanupFixtures(admin(), tracker, { keep })"]) expect(sc).toContain(s);
    expect(sc).not.toMatch(/\.delete\(\)/);
    expect(sc).not.toMatch(/from\("(centers|center_members|manager_centers|accounts|profiles)"\)\s*\.(delete|update)/);
    expect(read("tests/qa/fixtures/catalog.ts")).toContain("qaName(t.runId, `직접결제 ${totalCount}회 수강권`)");
  });
  it("실패 fixture 보존 옵션 유지, 기존 guard(QA_TARGET_PROJECT_REF/QA_PRODUCTION_ACK) 재사용", () => {
    expect(sc).toContain("shouldKeepFailedFixtures(process.env, failed)");
    expect(read("vitest.qa-production.config.ts")).toContain('setupFiles: ["tests/qa/qaEnv.ts"]');
  });
  it("별도 command(qa:production:direct-payment)에서만 실행되고 기본 test/integration/all에 연결되지 않는다", () => {
    const scripts = JSON.parse(read("package.json")).scripts as Record<string, string>;
    expect(scripts["qa:production:direct-payment"]).toBe("vitest run --config vitest.qa-production.config.ts tests/qa/scenarios/direct-payment-issue.qa.test.ts");
    for (const k of ["test", "test:integration", "test:all"]) expect(scripts[k]).not.toContain("qa");
    expect(sc).toContain("npm run qa:production:direct-payment");
  });
  it("QA 상품은 정상 판매 상태 일반 pass(10회, [QA <runId>] 이름), internal 센터 안에서만 생성", () => {
    const c = read("tests/qa/fixtures/catalog.ts");
    const fn = c.slice(c.indexOf("export async function createQaPassProduct"));
    for (const s of ['product_kind: "pass"', "is_on_sale: true", "is_active: true", "total_count: totalCount", "center_id: centerId", "opts?.totalCount ?? 10"]) expect(fn).toContain(s);
  });
});
