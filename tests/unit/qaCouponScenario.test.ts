/*
  Production QA 시나리오 3(센터 쿠폰 주문) 코드 계약 — Production에 접근하지 않고 검증한다.
  현재 구현 감사 결과: 쿠폰 할인은 서버(fulfill_order → _order_expected_amount)가 계산하고, 주문 amount가 서버 계산값과 다르면 보정하지 않고 확정을 거부한다.
  쿠폰은 주문 생성 시 예약/소비되지 않고 확정 성공 시에만 used + order_id로 소비된다.
*/
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCouponOrderInput } from "../qa/fixtures/directOrder";
import { CLEANUP_ORDER } from "../qa/runContext";

const root = join(__dirname, "../..");
const read = (p: string) => readFileSync(join(root, p), "utf-8");
const stripSql = (s: string) => s.replace(/--.*$/gm, "");
const sc = read("tests/qa/scenarios/coupon-order-issue.qa.test.ts");
const sql = stripSql(read("fix_order_issuance_and_auto_booking.sql"));
function fn(name: string): string {
  const start = sql.search(new RegExp(`create (or replace )?function (public\\.)?${name}\\(`, "i"));
  expect(start, name).toBeGreaterThan(-1);
  const rest = sql.slice(start + 10);
  const next = rest.search(/create (or replace )?function /i);
  return sql.slice(start, next === -1 ? undefined : start + 10 + next);
}

describe("실제 쿠폰 적용 경로(추측 없음)", () => {
  it("checkout direct 분기: 고른 센터 쿠폰을 memberCouponId로, 클라이언트 계산 금액/미리보기 할인을 createOrder에 전달", () => {
    const co = read("app/checkout/page.tsx");
    const direct = co.slice(co.indexOf('if (effectivePayMethod === "direct") {'), co.indexOf("// 나머지(카드/카카오페이/토스페이/계좌이체)"));
    expect(direct).toContain("amount: finalTotal");
    expect(direct).toContain("discountAmount: memberCouponDiscount");
    expect(direct).toContain("memberCouponId: selectedMemberCouponId ?? undefined");
    expect(co).toContain("previewDiscount(baseAmount, selectedMemberCoupon)");   // 클라이언트 값은 미리보기일 뿐
  });
  it("쿠폰 생성/지급은 앱 함수(createCoupon → coupons/coupon_products, issueCouponToMembers → issue_coupon_to_members)", () => {
    const lib = read("lib/coupons.ts");
    expect(lib).toContain('supabase.from("coupons").insert({');
    expect(lib).toContain('supabase.from("coupon_products").insert(');
    expect(lib).toContain('rpc("issue_coupon_to_members"');
    const fx = read("tests/qa/fixtures/coupons.ts");
    expect(fx).toContain('import { createCoupon, issueCouponToMembers } from "../../../lib/coupons"');
  });
  it("주문 생성(createOrder)은 쿠폰을 읽거나 소비하지 않는다 — 쿠폰 id만 orders.member_coupon_id에 싣는다", () => {
    const orders = read("lib/orders.ts");
    const create = orders.slice(orders.indexOf("export async function createOrder"), orders.indexOf("export async function fetchMyOrders"));
    expect(create).toContain("member_coupon_id: input.memberCouponId ?? null");
    expect(create).not.toMatch(/member_coupons|coupons"/);
  });
});

describe("서버 계약(SQL): 할인 계산 주체 = 서버, 금액 불일치는 거부, 쿠폰은 확정 성공 시에만 소비", () => {
  const expected = fn("_order_expected_amount");
  const fulfill = fn("fulfill_order");
  it("할인은 서버가 member_coupon/coupon 정의로 처음부터 계산하고 클라이언트의 discount_amount/coupon_code는 쓰지 않는다", () => {
    expect(expected).toContain("v_member_coupon.discount_value");
    expect(expected).toContain("greatest(0, v_base - v_verified_discount - coalesce(p_order.points_used, 0))");
    expect(expected).not.toMatch(/p_order\.discount_amount|p_order\.coupon_code/);
  });
  it("쿠폰 검증: 소유자/센터/상태(available)/유효기간/적용 대상/최소금액", () => {
    for (const m of ["본인에게 지급된 쿠폰만 사용할 수 있어요", "이 센터에서 사용할 수 없는 쿠폰이에요", "사용할 수 없는 쿠폰이에요(이미 사용됐거나 만료/회수됨)",
      "유효기간이 지난 쿠폰이에요", "이 수강권에는 사용할 수 없는 쿠폰이에요", "최소 결제금액"]) expect(expected).toContain(m);
    expect(expected).toContain("for update of mc");   // 확정 시 쿠폰 행을 잠가 동시 재사용을 직렬화
  });
  it("주문 amount가 서버 계산값과 다르면 보정하지 않고 거부(예외 → 트랜잭션 롤백, 쿠폰 미소비)", () => {
    expect(fulfill).toContain("v_order.amount is distinct from v_expected");
    expect(fulfill).toContain("주문 금액이 서버 계산 금액과 달라요");
    expect(fulfill).not.toMatch(/update orders set amount/i);
  });
  it("쿠폰은 발급 성공 시점에만 used + used_at + order_id로 소비된다(주문 생성 시 아님)", () => {
    expect(fulfill).toContain("set status = 'used', used_at = now(), order_id = v_order.id");
    expect(fulfill.indexOf("insert into memberships")).toBeLessThan(fulfill.indexOf("set status = 'used'"));
    const triggers = stripSql(read("add_selectable_count_pricing.sql"));
    expect(triggers).not.toMatch(/member_coupons/);   // 주문 INSERT 트리거는 쿠폰을 건드리지 않는다
  });
  it("결제 기록은 할인 후 금액(orders.amount)으로, 주문 snapshot은 원 상품가로 남는다", () => {
    expect(fulfill).toContain("v_order.amount, 0, now(), 'paid',");
    expect(fulfill).toContain("case when v_order.pay_method = 'direct' then v_order.amount else 0 end");
    expect(read("add_selectable_count_pricing.sql")).toContain("new.product_amount_snapshot := v_p.price;");
  });
});

describe("시나리오 계약", () => {
  it("입력 builder: checkout과 같은 모양(amount = 상품가 - 할인), 변조 시나리오는 amount/discount를 일부러 덮어쓴다", () => {
    const ok = buildCouponOrderInput({ centerId: "c", productId: "p", productName: "n", price: 50000, discountAmount: 10000, memberCouponId: "mc" });
    expect(ok).toMatchObject({ payMethod: "direct", amount: 40000, discountAmount: 10000, memberCouponId: "mc", pointsUsed: 0, autoBook: false });
    expect(buildCouponOrderInput({ centerId: "c", productId: "p", productName: "n", price: 50000, discountAmount: 0, memberCouponId: "mc", amount: 50000 }).amount).toBe(50000);
    expect(buildCouponOrderInput({ centerId: "c", productId: "p", productName: "n", price: 50000, discountAmount: 30000, memberCouponId: "mc", amount: 20000 }).discountAmount).toBe(30000);
  });
  it("fixture: 이번 runId 10회 수강권(50,000) + 정액 10,000 쿠폰(최소 30,000, 이번 상품 전용) + 변조용/다른 상품 전용 쿠폰, QA 회원에게 실제 지급", () => {
    for (const s of ["totalCount: 10", "const PRICE = 50000;", "const DISCOUNT = 10000;", "minimumOrderAmount: 30000", "productIds: [main.productId]", "productIds: [other.productId]", "쿠폰 정상 사용", "쿠폰 금액 변조 방어", "쿠폰 다른 상품 전용"]) expect(sc).toContain(s);
    expect(read("tests/qa/fixtures/coupons.ts")).toContain('discountType: "fixed"');
    expect(read("tests/qa/fixtures/coupons.ts")).toContain("qaName(t.runId, opts.label)");
  });
  it("확정 전: pending·쿠폰 available(예약 안 함)·수강권/결제 0건·snapshot=원가, 확정 후: done·금액/할인·수강권 1건·결제 1건(할인 후)·쿠폰 used+order_id", () => {
    for (const s of ['status: "available", used_at: null, order_id: null', "expect(o.product_amount_snapshot).toBe(PRICE)", "amount: FINAL, discount_amount: DISCOUNT",
      "expect(ps[0].total_amount).not.toBe(PRICE)", 'status: "used", order_id: orderA', "expect(mc.used_at).not.toBeNull()", "direct_amount: FINAL"]) expect(sc).toContain(s);
    expect(sc.indexOf("expect(await membershipsForMainProduct()).toHaveLength(0)")).toBeLessThan(sc.indexOf("managerConfirms(orderA)"));
  });
  it("재사용 방지: 같은 쿠폰의 두 번째(확정 전 생성)·세 번째(사용 후 생성) 주문 확정이 모두 거부되고 수강권 1건/쿠폰 order_id=A 유지", () => {
    expect(sc).toContain("managerConfirms(orderB)).rejects.toThrow(/사용할 수 없는 쿠폰/)");
    expect(sc).toContain("managerConfirms(orderC)).rejects.toThrow(/사용할 수 없는 쿠폰/)");
    expect(sc).toContain("expect(after.used_at).toBe(before.used_at)");
  });
  it("금액 변조 방어: 할인 없이/과도한 할인으로 보낸 주문은 '서버 계산 금액' 오류로 거부, 쿠폰 미소비·수강권 증가 없음", () => {
    expect(sc).toContain("amount: PRICE, discountAmount: 0");
    expect(sc).toContain("amount: PRICE - 30000, discountAmount: 30000");
    expect(sc).toContain("rejects.toThrow(/서버 계산 금액/)");
    expect(sc).toContain('status: "available", used_at: null, order_id: null });   // 쿠폰 미소비');
  });
  it("잘못된 쿠폰 방어: 다른 상품 전용 쿠폰 → '이 수강권에는 사용할 수 없는 쿠폰' 거부", () => {
    expect(sc).toContain("rejects.toThrow(/이 수강권에는 사용할 수 없는 쿠폰/)");
  });
  it("cleanup: 결제→수강권→주문→지급 쿠폰→쿠폰 적용 대상→쿠폰→상품(FK 순서), 이번 run UUID만, QA 센터/계정 유지, 알림 QA 계정만", () => {
    const o = (k: string) => CLEANUP_ORDER.indexOf(k as any);
    expect(o("payments")).toBeLessThan(o("memberships"));
    expect(o("memberships")).toBeLessThan(o("orders"));
    expect(o("orders")).toBeLessThan(o("member_coupons"));
    expect(o("member_coupons")).toBeLessThan(o("coupon_products"));
    expect(o("coupon_products")).toBeLessThan(o("coupons"));
    expect(o("coupons")).toBeLessThan(o("products"));
    expect(sc).toContain("cleanupFixtures(admin(), tracker, { keep })");
    expect(sc).toContain("shouldKeepFailedFixtures(process.env, failed)");
    expect(sc).not.toMatch(/\.delete\(\)/);
    expect(sc).toContain("recipient_account_id");
  });
  it("별도 command(qa:production:coupon)로만 실행, 기본 test/integration/all과 분리, 기존 guard 재사용", () => {
    const scripts = JSON.parse(read("package.json")).scripts as Record<string, string>;
    expect(scripts["qa:production:coupon"]).toBe("vitest run --config vitest.qa-production.config.ts tests/qa/scenarios/coupon-order-issue.qa.test.ts");
    for (const k of ["test", "test:integration", "test:all"]) expect(scripts[k]).not.toContain("qa");
    expect(read("vitest.qa-production.config.ts")).toContain('setupFiles: ["tests/qa/qaEnv.ts"]');
  });
});
