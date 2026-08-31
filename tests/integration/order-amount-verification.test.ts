/*
  SEC-118: orders.amount / points_used 위변조 방지 통합 테스트.

  ⚠️ 이 파일은 다음 SQL이 적용되기 전에는 의도적으로 FAIL해야 합니다:
    fix_orders_amount_server_verification.sql
  적용 후 green이 되어야 정상입니다.

  배경: confirm_test_payment()/confirm_real_payment()가 공유하는
  _issue_membership_and_record_payment()가 orders.amount를 그대로 믿고 즉시 수강권을
  발급했다(사람 검토 없음). createOrder()는 클라이언트가 계산한 amount를 그대로 저장하고
  RLS는 소유권만 검사하므로, 로그인한 회원이 임의 금액으로 주문을 만들어 confirm_test_payment를
  자기 주문에 호출하면 그 금액 그대로 수강권이 발급됐다.

  포인트 관련 테스트는 "points_used를 클라이언트가 주장하는 그대로 믿으면 안 된다"는,
  이 수정을 설계하며 직접 찾아낸 두 번째 구멍(최초 설계 초안엔 없었음 — fix SQL 상단 주석
  참고)을 검증한다: use_points()를 실제로 호출하지 않고 points_used만 주장하면 거부돼야 하고,
  다른 주문에서 실제로 쓴 포인트 차감을 재사용(같은 금액을 다른 주문에 또 주장)해도 거부돼야 한다.
*/
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { supabase } from "../../lib/supabaseClient";
import { createOrder } from "../../lib/orders";
import { usePoints } from "../../lib/reviews";
import { TEST_CENTER_ID, TEST_PRODUCT_ID, getFixtureAdminClient, signOutTestSession, switchToTestUser, type TestUser } from "./setup";

type ProductRow = { id: string; name: string; price: number };

let userA: TestUser;
let product: ProductRow;
const grantedPointTxIds: string[] = [];
// usePoints()가 실제로 만드는 차감(-) 행은 로그인 사용자 권한으로 생성돼 id를 직접 받지
// 못하므로, 이 파일이 points_used를 실제로 사용한 주문 id들을 모아뒀다가 order_id로 찾아 지운다.
const pointUsedOrderIds: string[] = [];

beforeAll(async () => {
  userA = await switchToTestUser("TEST_USER_A_EMAIL", "TEST_USER_A_PASSWORD");

  const { data, error } = await supabase
    .from("products")
    .select("id, name, price")
    .eq("id", TEST_PRODUCT_ID)
    .single();
  if (error || !data) {
    throw new Error(`TEST_PRODUCT_ID(${TEST_PRODUCT_ID})로 상품을 찾을 수 없습니다: ${error?.message ?? "no data"}`);
  }
  product = data as ProductRow;
});

// 다른 통합 테스트 파일이 같은 실행 중 공유 supabase 싱글턴의 세션을 바꿔놓을 수 있으므로,
// 매 테스트 직전에 기본 계정(A)으로 다시 로그인해 세션을 재확인한다(payment-security.test.ts와
// 동일한 패턴).
beforeEach(async () => {
  userA = await switchToTestUser("TEST_USER_A_EMAIL", "TEST_USER_A_PASSWORD");
});

afterAll(async () => {
  // 이 파일이 만든 point_transactions만 정리(실제 앱 잔액에 영구 흔적 안 남기기).
  // orders/memberships/payments는 다른 mock 통합 테스트(payment-lifecycle.test.ts 등)와
  // 동일한 기존 관례대로 정리하지 않는다(테스트 전용 프로젝트라 누적 무해).
  const admin = getFixtureAdminClient();
  if (grantedPointTxIds.length > 0) {
    await admin.from("point_transactions").delete().in("id", grantedPointTxIds);
  }
  if (pointUsedOrderIds.length > 0) {
    await admin.from("point_transactions").delete().in("order_id", pointUsedOrderIds);
  }
  await signOutTestSession();
});

async function grantTestPoints(amount: number): Promise<void> {
  const admin = getFixtureAdminClient();
  const { data, error } = await admin
    .from("point_transactions")
    .insert({ profile_id: userA.profileId, center_id: TEST_CENTER_ID, amount, reason: "SEC-118 테스트 적립" })
    .select("id")
    .single();
  if (error || !data) throw new Error(`테스트 포인트 지급 실패: ${error?.message ?? "no data"}`);
  grantedPointTxIds.push(data.id);
}

describe("SEC-118: 주문 금액 서버 검증", () => {
  it("정상 금액이면 confirm_test_payment가 성공한다 (회귀 확인)", async () => {
    const orderId = await createOrder({
      centerId: TEST_CENTER_ID, productId: product.id, productName: product.name,
      amount: product.price, payMethod: "card", provider: "mock",
    });

    const { data, error } = await supabase.rpc("confirm_test_payment", {
      p_order_id: orderId, p_provider_ref: "amount-ok",
    });
    expect(error).toBeNull();
    expect((data as any).already_done).toBe(false);
    expect((data as any).amount).toBe(product.price);
  });

  it("상품 가격보다 낮게 조작한 금액은 거부된다", async () => {
    const orderId = await createOrder({
      centerId: TEST_CENTER_ID, productId: product.id, productName: product.name,
      amount: 1, payMethod: "card", provider: "mock",
    });

    const { data, error } = await supabase.rpc("confirm_test_payment", {
      p_order_id: orderId, p_provider_ref: "amount-tampered",
    });
    expect(data).toBeNull();
    expect(error).not.toBeNull();
    expect(error!.message).toContain("주문 금액이 상품 가격과 일치하지 않아요");
  });

  it("알려지지 않은 쿠폰 코드로 할인을 주장하면 거부된다(할인 0원 취급)", async () => {
    const orderId = await createOrder({
      centerId: TEST_CENTER_ID, productId: product.id, productName: product.name,
      amount: Math.max(0, product.price - 9999), payMethod: "card", provider: "mock",
      couponCode: "FAKE-COUPON", discountAmount: 9999,
    });

    const { data, error } = await supabase.rpc("confirm_test_payment", {
      p_order_id: orderId, p_provider_ref: "fake-coupon",
    });
    expect(data).toBeNull();
    expect(error).not.toBeNull();
    expect(error!.message).toContain("주문 금액이 상품 가격과 일치하지 않아요");
  });

  it("서버가 신뢰하는 쿠폰(WELCOME=5000원)을 정확히 반영한 금액이면 승인된다", async () => {
    const expected = Math.max(0, product.price - 5000);
    const orderId = await createOrder({
      centerId: TEST_CENTER_ID, productId: product.id, productName: product.name,
      amount: expected, payMethod: "card", provider: "mock",
      couponCode: "WELCOME", discountAmount: 5000,
    });

    const { data, error } = await supabase.rpc("confirm_test_payment", {
      p_order_id: orderId, p_provider_ref: "real-coupon",
    });
    expect(error).toBeNull();
    expect((data as any).amount).toBe(expected);
  });

  it("실제로 use_points()를 호출하지 않고 points_used만 주장하면 거부된다", async () => {
    const claimed = 1000;
    const orderId = await createOrder({
      centerId: TEST_CENTER_ID, productId: product.id, productName: product.name,
      amount: Math.max(0, product.price - claimed), payMethod: "card", provider: "mock",
      pointsUsed: claimed, // use_points()를 실제로 호출하지 않음 — 클라이언트 주장뿐
    });

    const { data, error } = await supabase.rpc("confirm_test_payment", {
      p_order_id: orderId, p_provider_ref: "fake-points",
    });
    expect(data).toBeNull();
    expect(error).not.toBeNull();
    expect(error!.message).toContain("포인트 사용 내역이 확인되지 않아");
  });

  it("이 주문번호로 실제 use_points()를 호출해 정확히 연결된 포인트만큼 할인하면 승인된다", async () => {
    await grantTestPoints(5000);
    const used = 1000;
    const orderId = await createOrder({
      centerId: TEST_CENTER_ID, productId: product.id, productName: product.name,
      amount: Math.max(0, product.price - used), payMethod: "card", provider: "mock",
      pointsUsed: used,
    });
    await usePoints(TEST_CENTER_ID, used, orderId);
    pointUsedOrderIds.push(orderId);

    const { data, error } = await supabase.rpc("confirm_test_payment", {
      p_order_id: orderId, p_provider_ref: "real-points",
    });
    expect(error).toBeNull();
    expect((data as any).amount).toBe(Math.max(0, product.price - used));
  });

  it("다른 주문에서 실제로 쓴 포인트를 이 주문에 재사용 주장하면 거부된다(주문별 연결 확인)", async () => {
    await grantTestPoints(5000);
    const used = 1000;

    // 주문 A: 실제로 이 주문번호로 포인트를 정상 사용
    const orderIdA = await createOrder({
      centerId: TEST_CENTER_ID, productId: product.id, productName: product.name,
      amount: Math.max(0, product.price - used), payMethod: "card", provider: "mock",
      pointsUsed: used,
    });
    await usePoints(TEST_CENTER_ID, used, orderIdA);
    pointUsedOrderIds.push(orderIdA);

    // 주문 B: 별개 주문인데 A에서 쓴 것과 같은 points_used를 주장(그 자체를 다시 쓴 적 없음)
    const orderIdB = await createOrder({
      centerId: TEST_CENTER_ID, productId: product.id, productName: product.name,
      amount: Math.max(0, product.price - used), payMethod: "card", provider: "mock",
      pointsUsed: used,
    });

    const { data, error } = await supabase.rpc("confirm_test_payment", {
      p_order_id: orderIdB, p_provider_ref: "reused-points-claim",
    });
    expect(data).toBeNull();
    expect(error).not.toBeNull();
    expect(error!.message).toContain("포인트 사용 내역이 확인되지 않아");

    // 정리: A는 정상 처리된 주문이라 그대로 둬도 되지만(다른 통합 테스트와 동일한 패턴으로
    // 이 파일도 생성된 memberships/payments를 별도로 지우지 않음 — 기존 관례), B는 확정
    // 실패로 pending에 머무르므로 별도 정리가 필요 없다(다른 pending 테스트 주문과 동일).
  });
});
