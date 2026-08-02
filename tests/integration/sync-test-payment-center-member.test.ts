/*
  SYNC-001 회귀 테스트 — Mock 결제(confirm_test_payment)로 수강권을 처음 받은 회원이
  fulfill_order()(정식 결제 경로)와 동일하게 center_members에 등록되는지 검증한다.

  ⚠️ 이 파일은 fix_sync_test_payment_center_member_draft_proposed.sql이 적용되기 전에는
  의도적으로 FAIL해야 합니다(현재 confirm_test_payment()는 ensure_center_member를 호출하지
  않음). 적용 후 green이 되어야 정상입니다.

  실제 checkout이 호출하는 lib/orders.ts/lib/payments의 진짜 함수를 그대로 재사용한다
  (payment-lifecycle.test.ts와 동일한 관례).
*/
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { supabase } from "../../lib/supabaseClient";
import { createOrder } from "../../lib/orders";
import { getPaymentService } from "../../lib/payments";
import { TEST_CENTER_ID, TEST_PRODUCT_ID, switchToTestUser, type TestUser } from "./setup";

type ProductRow = { id: string; name: string; price: number };

let testUser: TestUser;
let product: ProductRow;

beforeAll(async () => {
  testUser = await switchToTestUser("TEST_USER_A_EMAIL", "TEST_USER_A_PASSWORD");
  const { data, error } = await supabase
    .from("products").select("id, name, price").eq("id", TEST_PRODUCT_ID).single();
  if (error || !data) throw new Error(`TEST_PRODUCT_ID로 상품을 찾을 수 없습니다: ${error?.message ?? "no data"}`);
  product = data as ProductRow;
});

beforeEach(async () => {
  testUser = await switchToTestUser("TEST_USER_A_EMAIL", "TEST_USER_A_PASSWORD");
});

describe("SYNC-001: Mock 결제 확정 시 center_members 자동 등록", () => {
  it("Mock 결제로 수강권을 받으면 그 센터의 center_members에 active로 등록된다", async () => {
    const orderId = await createOrder({
      centerId: TEST_CENTER_ID, productId: product.id, productName: product.name,
      amount: product.price, payMethod: "card", provider: "mock",
    });
    const paymentService = getPaymentService("success");
    const created = await paymentService.createPayment({ orderId, amount: product.price });
    const result = await paymentService.confirmPayment(created.paymentKey, orderId);
    expect(result.status).toBe("paid");

    const { data, error } = await supabase
      .from("center_members")
      .select("status")
      .eq("center_id", TEST_CENTER_ID)
      .eq("profile_id", testUser.profileId)
      .maybeSingle();
    expect(error).toBeNull();
    expect(data).not.toBeNull();
    expect((data as any).status).toBe("active");
  });
});
