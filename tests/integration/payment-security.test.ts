/*
  confirm_test_payment / cancel_test_payment의 보안 가드 통합 테스트.
  - 본인 소유가 아닌 주문 거부
  - payment_provider='mock'이 아닌 주문 거부
  - 존재하지 않는 주문 거부
  실제 RPC를 실제 권한 모델(security definer + 본인 검증)로 호출해 검증한다.
*/
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { supabase } from "../../lib/supabaseClient";
import { createOrder } from "../../lib/orders";
import { TEST_PRODUCT_ID, signOutTestSession, switchToTestUser, type TestUser } from "./setup";

type ProductRow = { id: string; name: string; price: number };

let userA: TestUser;
let product: ProductRow;

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
// 매 테스트 직전에 기본 계정(A)으로 다시 로그인해 세션을 재확인한다. B로 전환이 필요한
// 테스트는 그 안에서 명시적으로 다시 전환한다(아래 그대로 유지 — 이미 그렇게 되어 있음).
beforeEach(async () => {
  userA = await switchToTestUser("TEST_USER_A_EMAIL", "TEST_USER_A_PASSWORD");
});

afterAll(async () => {
  await signOutTestSession();
});

describe("본인 주문만 처리 가능 (RLS)", () => {
  it("계정 B가 계정 A의 주문을 확정하려 하면 거부된다", async () => {
    // A로 전환해 A 소유 주문 생성 (확정하지 않고 pending으로 둠)
    await switchToTestUser("TEST_USER_A_EMAIL", "TEST_USER_A_PASSWORD");
    const orderId = await createOrder({
      productId: product.id,
      payMethod: "card",
      provider: "mock",
    });

    // B로 전환해 A의 주문을 확정 시도
    await switchToTestUser("TEST_USER_B_EMAIL", "TEST_USER_B_PASSWORD");
    const { data, error } = await supabase.rpc("confirm_test_payment", {
      p_order_id: orderId,
      p_provider_ref: "should-be-rejected",
    });

    expect(data).toBeNull();
    expect(error).not.toBeNull();
    expect(error!.message).toContain("본인 주문만 확정할 수 있어요");

    // 되돌아가서 다음 테스트에 영향 없도록 A로 복귀
    await switchToTestUser("TEST_USER_A_EMAIL", "TEST_USER_A_PASSWORD");
  });
});

describe("Mock 결제만 처리 가능", () => {
  it("payment_provider가 mock이 아닌 주문(cart 등 레거시 경로)은 거부된다", async () => {
    // provider를 지정하지 않음 = app/cart/page.tsx가 만드는 주문과 동일(payment_provider null)
    const orderId = await createOrder({
      productId: product.id,
      payMethod: "card",
    });

    const { data, error } = await supabase.rpc("confirm_test_payment", {
      p_order_id: orderId,
      p_provider_ref: "should-be-rejected",
    });

    expect(data).toBeNull();
    expect(error).not.toBeNull();
    expect(error!.message).toContain("테스트 결제 확정은 Mock 결제 주문에만 사용할 수 있어요");
  });
});

describe("RPC 함수 동작 (엣지 케이스)", () => {
  it("존재하지 않는 주문 id로 호출하면 명확한 에러를 반환한다", async () => {
    const { data, error } = await supabase.rpc("confirm_test_payment", {
      p_order_id: "00000000-0000-0000-0000-000000000000",
      p_provider_ref: "no-such-order",
    });
    expect(data).toBeNull();
    expect(error).not.toBeNull();
    expect(error!.message).toContain("주문을 찾을 수 없어요");
  });

  it("cancel_test_payment도 동일한 본인 소유 가드를 적용한다", async () => {
    await switchToTestUser("TEST_USER_A_EMAIL", "TEST_USER_A_PASSWORD");
    const orderId = await createOrder({
      productId: product.id,
      payMethod: "card",
      provider: "mock",
    });

    await switchToTestUser("TEST_USER_B_EMAIL", "TEST_USER_B_PASSWORD");
    const { data, error } = await supabase.rpc("cancel_test_payment", { p_order_id: orderId });

    expect(data).toBeNull();
    expect(error).not.toBeNull();
    expect(error!.message).toContain("본인 주문만 취소할 수 있어요");

    await switchToTestUser("TEST_USER_A_EMAIL", "TEST_USER_A_PASSWORD");
  });
});
