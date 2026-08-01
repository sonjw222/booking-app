/*
  결제 성공 / 취소 / Idempotency / DB 정합성 통합 테스트.
  실제 개발용 Supabase에 실제 RPC(confirm_test_payment/cancel_test_payment)를 호출한다.
  UI는 전혀 거치지 않지만, checkout이 실제로 호출하는 lib/orders.ts / lib/payments의
  진짜 함수를 그대로 사용한다(재구현하지 않음).
*/
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { supabase } from "../../lib/supabaseClient";
import { createOrder } from "../../lib/orders";
import { getPaymentService } from "../../lib/payments";
import {
  TEST_CENTER_ID,
  TEST_PRODUCT_ID,
  countMembershipsFor,
  fetchLatestMembership,
  fetchOrderRow,
  fetchPaymentByMembership,
  switchToTestUser,
  type TestUser,
} from "./setup";

type ProductRow = { id: string; name: string; price: number };

let testUser: TestUser;
let product: ProductRow;

beforeAll(async () => {
  testUser = await switchToTestUser("TEST_USER_A_EMAIL", "TEST_USER_A_PASSWORD");

  const { data, error } = await supabase
    .from("products")
    .select("id, name, price")
    .eq("id", TEST_PRODUCT_ID)
    .single();
  if (error || !data) {
    throw new Error(
      `TEST_PRODUCT_ID(${TEST_PRODUCT_ID})로 상품을 찾을 수 없습니다: ${error?.message ?? "no data"}`
    );
  }
  product = data as ProductRow;
});

afterAll(async () => {
  await supabase.auth.signOut();
});

async function createMockOrder(): Promise<string> {
  return createOrder({
    centerId: TEST_CENTER_ID,
    productId: product.id,
    productName: product.name,
    amount: product.price,
    payMethod: "card",
    provider: "mock",
  });
}

describe("성공 결제", () => {
  it("확정 성공 시 orders=done, memberships/payments가 정확히 1건씩 생성된다", async () => {
    const beforeCount = await countMembershipsFor(testUser.profileId, product.id);

    const orderId = await createMockOrder();
    const orderBefore = await fetchOrderRow(orderId);
    expect(orderBefore.status).toBe("pending");
    expect(orderBefore.payment_provider).toBe("mock");

    const paymentService = getPaymentService("success");
    const created = await paymentService.createPayment({ orderId, amount: product.price });
    const result = await paymentService.confirmPayment(created.paymentKey, orderId);

    expect(result.status).toBe("paid");
    expect(result.membershipId).toBeTruthy();

    const orderAfter = await fetchOrderRow(orderId);
    expect(orderAfter.status).toBe("done");
    expect(orderAfter.paid_at).toBeTruthy();

    const afterCount = await countMembershipsFor(testUser.profileId, product.id);
    expect(afterCount).toBe(beforeCount + 1);

    const membership = await fetchLatestMembership(testUser.profileId, product.id);
    expect(membership).not.toBeNull();
    expect(membership!.id).toBe(result.membershipId);
    expect(membership!.status).toBe("active");
    expect(membership!.remaining_count).toBe(membership!.total_count);

    const payment = await fetchPaymentByMembership(result.membershipId!);
    expect(payment).not.toBeNull();
    expect(payment!.status).toBe("paid");
    expect(payment!.total_amount).toBe(product.price);
    expect(payment!.pg_transaction_id).toBe(created.paymentKey);
  });
});

describe("취소 결제", () => {
  it("확정 대신 취소 시 orders=cancelled, memberships/payments는 생성되지 않는다", async () => {
    const beforeCount = await countMembershipsFor(testUser.profileId, product.id);

    const orderId = await createMockOrder();
    const paymentService = getPaymentService("cancelled");
    const created = await paymentService.createPayment({ orderId, amount: product.price });
    const result = await paymentService.confirmPayment(created.paymentKey, orderId);

    expect(result.status).toBe("cancelled");

    const order = await fetchOrderRow(orderId);
    expect(order.status).toBe("cancelled");

    const afterCount = await countMembershipsFor(testUser.profileId, product.id);
    expect(afterCount).toBe(beforeCount); // 취소된 주문으로는 수강권이 늘어나지 않아야 함
  });
});

describe("Idempotency (중복 확정 방지)", () => {
  it("같은 주문을 두 번 순차 확정해도 memberships/payments가 1건만 유지된다", async () => {
    const orderId = await createMockOrder();
    const paymentService = getPaymentService("success");
    const created = await paymentService.createPayment({ orderId, amount: product.price });

    const first = await paymentService.confirmPayment(created.paymentKey, orderId);
    expect(first.status).toBe("paid");
    const membershipId = first.membershipId!;

    // 같은 orderId로 RPC를 한 번 더 호출 (checkout이 실수로 두 번 눌리는 상황을 흉내)
    const { data, error } = await supabase.rpc("confirm_test_payment", {
      p_order_id: orderId,
      p_provider_ref: created.paymentKey,
    });
    expect(error).toBeNull();
    expect((data as { already_done: boolean }).already_done).toBe(true);

    const paymentsForMembership = await fetchPaymentByMembership(membershipId);
    expect(paymentsForMembership).not.toBeNull(); // 여전히 1건 존재(중복 생성 안 됐다는 것은 아래 count로 재확인)

    const { count, error: countError } = await supabase
      .from("payments")
      .select("id", { count: "exact", head: true })
      .eq("membership_id", membershipId);
    if (countError) throw new Error(countError.message);
    expect(count).toBe(1);
  });

  it("같은 주문을 진짜 동시에 두 번 호출해도(Promise.all) memberships가 1건만 생성된다", async () => {
    const orderId = await createMockOrder();

    const call = () => supabase.rpc("confirm_test_payment", { p_order_id: orderId, p_provider_ref: "concurrent-test" });
    const [r1, r2] = await Promise.all([call(), call()]);

    // 둘 다 에러 없이 끝나야 하고(둘 중 하나는 already_done:true), 실제 발급은 1건만 돼야 한다
    expect(r1.error).toBeNull();
    expect(r2.error).toBeNull();

    const alreadyDoneCount = [r1, r2].filter(
      (r) => (r.data as { already_done: boolean }).already_done === true
    ).length;
    expect(alreadyDoneCount).toBe(1); // 둘 중 정확히 하나만 "이미 처리됨"이어야 함(= 나머지 하나가 실제 발급)

    const afterOrder = await fetchOrderRow(orderId);
    expect(afterOrder.status).toBe("done");

    const membership = await fetchLatestMembership(testUser.profileId, product.id);
    expect(membership).not.toBeNull();
    const { count, error: countError } = await supabase
      .from("payments")
      .select("id", { count: "exact", head: true })
      .eq("membership_id", membership!.id);
    if (countError) throw new Error(countError.message);
    expect(count).toBe(1); // for update 행 잠금 덕분에 동시 호출에도 중복 발급 없음
  });
});
