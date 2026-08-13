/*
  SEC-118: orders.amount 클라이언트 신뢰 문제 회귀 테스트.

  핵심 시나리오:
  - create_order_secure()가 products.price를 서버에서 직접 계산해 orders.amount를
    만들고 verified=true로 표시하는지(AMOUNT-SEC-A~D).
  - [가장 중요] verified=false(레거시/직접 insert 경로) 주문 중 orders.amount가
    products.price와 다르면(=조작 시도) fulfill_order()가 이를 거부하는지
    (AMOUNT-SEC-E) — 이 fix 이전에는 이 방어가 전혀 없어 임의 금액으로 정상 상품을
    받을 수 있었다(docs/25_SEC118_Orders_Amount_Design.md 1절 참고).
  - 같은 조건에서도 amount가 우연히 price와 일치하는 정상 레거시 주문은 그대로
    처리되는지(AMOUNT-SEC-F, 하위호환 확인).

  실제 checkout/cart가 호출하는 lib/orders.ts의 진짜 createOrder()를 그대로 사용한다
  (재구현하지 않음, payment-lifecycle.test.ts와 동일한 관례).
*/
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { supabase } from "../../lib/supabaseClient";
import { createOrder } from "../../lib/orders";
import {
  TEST_CENTER_ID,
  fetchOrderRow,
  getFixtureAdminClient,
  signOutTestSession,
  switchToTestUser,
  type TestUser,
} from "./setup";

let testUser: TestUser;
const cleanupProductIds: string[] = [];

async function createTestProduct(name: string, price: number, opts?: { isOnSale?: boolean; isActive?: boolean }) {
  const admin = getFixtureAdminClient();
  const { data, error } = await admin
    .from("products")
    .insert({
      center_id: TEST_CENTER_ID, name, product_kind: "pass", pass_type: "count",
      price, total_count: 10,
      is_on_sale: opts?.isOnSale ?? true, is_active: opts?.isActive ?? true,
    })
    .select("id, price")
    .single();
  if (error || !data) throw new Error(`테스트 상품 생성 실패: ${error?.message}`);
  cleanupProductIds.push(data.id);
  return data as { id: string; price: number };
}

beforeAll(async () => {
  testUser = await switchToTestUser("TEST_USER_A_EMAIL", "TEST_USER_A_PASSWORD");
});

beforeEach(async () => {
  testUser = await switchToTestUser("TEST_USER_A_EMAIL", "TEST_USER_A_PASSWORD");
});

afterAll(async () => {
  const admin = getFixtureAdminClient();
  for (const id of cleanupProductIds) await admin.from("products").delete().eq("id", id);
  await signOutTestSession();
});

describe("AMOUNT-SEC-A~D: create_order_secure()가 금액을 직접 계산한다", () => {
  it("AMOUNT-SEC-A: 생성된 주문의 amount는 정확히 products.price와 같고 verified=true다", async () => {
    const product = await createTestProduct("SEC-118-A", 37000);
    const orderId = await createOrder({ productId: product.id, payMethod: "card" });
    const order = await fetchOrderRow(orderId);
    expect(order.amount).toBe(37000);

    const admin = getFixtureAdminClient();
    const { data } = await admin.from("orders").select("verified").eq("id", orderId).single();
    expect((data as any).verified).toBe(true);
  });

  it("AMOUNT-SEC-B: 존재하지 않는 product_id로는 주문을 만들 수 없다", async () => {
    const { data, error } = await supabase.rpc("create_order_secure", {
      p_product_id: "00000000-0000-0000-0000-000000000000",
    });
    expect(data).toBeNull();
    expect(error).not.toBeNull();
    expect(error!.message).toContain("상품을 찾을 수 없어요");
  });

  it("AMOUNT-SEC-C: 판매 중지(is_on_sale=false) 상품은 주문할 수 없다", async () => {
    const product = await createTestProduct("SEC-118-C", 10000, { isOnSale: false });
    const { data, error } = await supabase.rpc("create_order_secure", { p_product_id: product.id });
    expect(data).toBeNull();
    expect(error).not.toBeNull();
    expect(error!.message).toContain("지금은 구매할 수 없는 상품이에요");
  });

  it("AMOUNT-SEC-D: 비활성(is_active=false) 상품은 주문할 수 없다", async () => {
    const product = await createTestProduct("SEC-118-D", 10000, { isActive: false });
    const { data, error } = await supabase.rpc("create_order_secure", { p_product_id: product.id });
    expect(data).toBeNull();
    expect(error).not.toBeNull();
    expect(error!.message).toContain("지금은 구매할 수 없는 상품이에요");
  });
});

describe("AMOUNT-SEC-E~F: fulfill_order()의 verified=false 재검증 (핵심 회귀)", () => {
  // fulfill_order()는 매니저/오너 전용이라 호출 전 platform admin으로 임시 승격한다
  // (TEST_CENTER_ID를 실제로 누가 관리하는지 몰라도 되는, tests/integration/
  // auto-book-membership-security.test.ts AUTO-SEC-K와 동일한 패턴).
  async function asTempPlatformAdmin<T>(fn: () => Promise<T>): Promise<T> {
    const admin = getFixtureAdminClient();
    const { error: elevateErr } = await admin
      .from("accounts").update({ is_platform_admin: true }).eq("id", testUser.accountId);
    if (elevateErr) throw new Error("platform admin 승격 실패: " + elevateErr.message);
    try {
      return await fn();
    } finally {
      const { error: resetErr } = await admin
        .from("accounts").update({ is_platform_admin: false }).eq("id", testUser.accountId);
      if (resetErr) throw new Error("platform admin 원복 실패: " + resetErr.message);
    }
  }

  it("AMOUNT-SEC-E: create_order_secure를 거치지 않고 직접 insert한 조작 금액 주문은 fulfill_order가 거부한다", async () => {
    const product = await createTestProduct("SEC-118-E", 50000);
    const admin = getFixtureAdminClient();
    // SEC-118 이전 취약점을 그대로 재현: RLS를 우회(admin client)해 실제 가격(50000)과
    // 다른 임의 금액(1000)으로 직접 orders에 insert — profile_id 소유권만 확인하면
    // 통과했던 원래 orders INSERT RLS를 흉내낸다(일반 로그인 client로도 동일하게 가능했던
    // 경로 — RLS가 amount를 전혀 검증하지 않았으므로).
    const { data: order, error: insertErr } = await admin
      .from("orders")
      .insert({
        center_id: TEST_CENTER_ID, profile_id: testUser.profileId, product_id: product.id,
        product_name: "SEC-118-E", amount: 1000, pay_method: "card", status: "pending",
      })
      .select("id")
      .single();
    if (insertErr || !order) throw new Error("조작 주문 생성 실패: " + insertErr?.message);

    await asTempPlatformAdmin(async () => {
      const { data, error } = await supabase.rpc("fulfill_order", { p_order_id: (order as any).id });
      expect(data).toBeNull();
      expect(error).not.toBeNull();
      expect(error!.message).toContain("주문 금액을 확인할 수 없어요");
    });
  });

  it("AMOUNT-SEC-F: 직접 insert했더라도 amount가 products.price와 일치하면(정상 레거시 주문) 그대로 처리된다", async () => {
    const product = await createTestProduct("SEC-118-F", 20000);
    const admin = getFixtureAdminClient();
    const { data: order, error: insertErr } = await admin
      .from("orders")
      .insert({
        center_id: TEST_CENTER_ID, profile_id: testUser.profileId, product_id: product.id,
        product_name: "SEC-118-F", amount: 20000, pay_method: "card", status: "pending",
      })
      .select("id")
      .single();
    if (insertErr || !order) throw new Error("주문 생성 실패: " + insertErr?.message);

    await asTempPlatformAdmin(async () => {
      const { data, error } = await supabase.rpc("fulfill_order", { p_order_id: (order as any).id });
      expect(error).toBeNull();
      expect((data as any)?.already_done).toBe(false);
      expect((data as any)?.membership_id).toBeTruthy();
    });
  });
});
