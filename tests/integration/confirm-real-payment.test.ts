/*
  P0-1 후속: confirm_real_payment/cancel_real_payment(add_confirm_real_payment.sql) 검증.

  이 RPC들은 app/api/payments/confirm·cancel(서버 라우트, service_role 키)에서만 호출되는
  게 정상이라, 여기서도 getFixtureAdminClient()(service_role)로 직접 호출해 그 라우트가
  하는 일을 그대로 재현한다. 추가로 일반 로그인 세션(authenticated)이 이 RPC를 직접
  호출하면 반드시 거부되는지도 확인한다(그렇지 않으면 누구나 자기 주문을 결제 검증 없이
  확정시킬 수 있는 심각한 보안 구멍이 된다).
*/
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { supabase } from "../../lib/supabaseClient";
import { createOrder } from "../../lib/orders";
import {
  TEST_CENTER_ID,
  TEST_PRODUCT_ID,
  countMembershipsFor,
  fetchLatestMembership,
  fetchOrderRow,
  fetchPaymentByMembership,
  getFixtureAdminClient,
  signOutTestSession,
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
    throw new Error(`TEST_PRODUCT_ID(${TEST_PRODUCT_ID})로 상품을 찾을 수 없습니다: ${error?.message ?? "no data"}`);
  }
  product = data as ProductRow;
});

beforeEach(async () => {
  testUser = await switchToTestUser("TEST_USER_A_EMAIL", "TEST_USER_A_PASSWORD");
});

afterAll(async () => {
  await signOutTestSession();
});

async function createTossOrder(): Promise<string> {
  return createOrder({
    centerId: TEST_CENTER_ID,
    productId: product.id,
    productName: product.name,
    amount: product.price,
    payMethod: "card",
    provider: "toss",
  });
}

describe("confirm_real_payment — 서버(service_role) 경로만 성공한다", () => {
  it("일반 로그인 세션(authenticated)이 직접 호출하면 거부된다", async () => {
    const orderId = await createTossOrder();
    const { error } = await supabase.rpc("confirm_real_payment", {
      p_order_id: orderId,
      p_payment_key: "test_payment_key",
      p_amount: product.price,
    });
    expect(error).not.toBeNull();
    // service_role에만 EXECUTE 권한이 있으므로 Postgres가 permission denied(42501)로 거부해야 함
    expect(error!.message.toLowerCase()).toMatch(/permission denied|denied/);
  });

  it("service_role로 호출하면 orders=done, memberships/payments가 정확히 1건씩 생성된다", async () => {
    const admin = getFixtureAdminClient();
    const beforeCount = await countMembershipsFor(testUser.profileId, product.id);

    const orderId = await createTossOrder();
    const orderBefore = await fetchOrderRow(orderId);
    expect(orderBefore.status).toBe("pending");
    expect(orderBefore.payment_provider).toBe("toss");

    const fakePaymentKey = `test_toss_payment_key_${orderId}`;
    const { data, error } = await admin.rpc("confirm_real_payment", {
      p_order_id: orderId,
      p_payment_key: fakePaymentKey,
      p_amount: product.price,
    });
    expect(error).toBeNull();
    const result = data as { already_done: boolean; membership_id: string; amount: number };
    expect(result.already_done).toBe(false);
    expect(result.membership_id).toBeTruthy();

    const orderAfter = await fetchOrderRow(orderId);
    expect(orderAfter.status).toBe("done");

    const afterCount = await countMembershipsFor(testUser.profileId, product.id);
    expect(afterCount).toBe(beforeCount + 1);

    const membership = await fetchLatestMembership(testUser.profileId, product.id);
    expect(membership).not.toBeNull();
    expect(membership!.id).toBe(result.membership_id);

    const payment = await fetchPaymentByMembership(result.membership_id);
    expect(payment).not.toBeNull();
    expect(payment!.pg_transaction_id).toBe(fakePaymentKey);
    expect(payment!.total_amount).toBe(product.price);
  });

  it("주문 금액과 다른 amount로 호출하면 거부되고 아무것도 발급되지 않는다", async () => {
    const admin = getFixtureAdminClient();
    const orderId = await createTossOrder();

    const { error } = await admin.rpc("confirm_real_payment", {
      p_order_id: orderId,
      p_payment_key: "mismatch_test",
      p_amount: product.price + 1000,
    });
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/일치하지 않아요/);

    const order = await fetchOrderRow(orderId);
    expect(order.status).toBe("pending"); // 확정되지 않고 그대로 pending
  });

  it("같은 주문을 두 번 확정해도(idempotency) memberships/payments가 1건만 유지된다", async () => {
    const admin = getFixtureAdminClient();
    const orderId = await createTossOrder();

    const first = await admin.rpc("confirm_real_payment", {
      p_order_id: orderId, p_payment_key: "dup_test", p_amount: product.price,
    });
    expect(first.error).toBeNull();
    const membershipId = (first.data as { membership_id: string }).membership_id;

    const second = await admin.rpc("confirm_real_payment", {
      p_order_id: orderId, p_payment_key: "dup_test", p_amount: product.price,
    });
    expect(second.error).toBeNull();
    expect((second.data as { already_done: boolean }).already_done).toBe(true);

    const { count, error: countError } = await admin
      .from("payments")
      .select("id", { count: "exact", head: true })
      .eq("membership_id", membershipId);
    if (countError) throw new Error(countError.message);
    expect(count).toBe(1);
  });
});

describe("cancel_real_payment — 서버(service_role) 경로만 성공한다", () => {
  it("일반 로그인 세션이 직접 호출하면 거부된다", async () => {
    const orderId = await createTossOrder();
    const { error } = await supabase.rpc("cancel_real_payment", { p_order_id: orderId });
    expect(error).not.toBeNull();
    expect(error!.message.toLowerCase()).toMatch(/permission denied|denied/);
  });

  it("service_role로 호출하면 orders=cancelled로 바뀌고 수강권은 발급되지 않는다", async () => {
    const admin = getFixtureAdminClient();
    const beforeCount = await countMembershipsFor(testUser.profileId, product.id);

    const orderId = await createTossOrder();
    const { data, error } = await admin.rpc("cancel_real_payment", { p_order_id: orderId });
    expect(error).toBeNull();
    expect((data as { cancelled: boolean }).cancelled).toBe(true);

    const order = await fetchOrderRow(orderId);
    expect(order.status).toBe("cancelled");

    const afterCount = await countMembershipsFor(testUser.profileId, product.id);
    expect(afterCount).toBe(beforeCount);
  });
});
