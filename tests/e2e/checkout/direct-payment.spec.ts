import { test, expect } from "@playwright/test";
import {
  loadTestAccountMeta,
  getOrCreateOwnedTestCenter,
  getOrCreateTestPassProductNamed,
  type TestUser,
} from "../fixtures/testData";
import { getFixtureAdminClient } from "../../integration/setup";
import { MEMBER_AUTH_FILE } from "../fixtures/authFiles";

/*
  "직접결제 (센터에서 결제)" 회귀 테스트 — P0-1 후속(계좌이체/직접결제 연동).

  배경: 이 결제수단은 실제 PG를 전혀 거치지 않는다 — 실제 PG(토스) 연동 이전의 원래 흐름과
  동일하게 주문만 status='pending'으로 접수하고, 매니저가 기존 "미발급 주문" 화면
  (fulfill_order)에서 결제 확인 후 수동으로 발급한다. app/checkout/page.tsx의 handlePay()가
  이 결제수단을 고르면 PaymentService(Mock/Toss)를 아예 호출하지 않고 즉시 접수 화면만
  보여주는지 실브라우저로 확인한다.
*/

test.use({ storageState: MEMBER_AUTH_FILE });

let managerA: TestUser;
let userA: TestUser;
let centerAId: string;
let productId: string;
const PRODUCT_NAME = "E2E 직접결제 테스트 수강권";

test.beforeAll(async () => {
  managerA = loadTestAccountMeta("manager-a");
  userA = loadTestAccountMeta("user-a");
  centerAId = await getOrCreateOwnedTestCenter(managerA);
  const product = await getOrCreateTestPassProductNamed(centerAId, PRODUCT_NAME);
  productId = product.id;
});

test.afterAll(async () => {
  const admin = getFixtureAdminClient();
  await admin.from("orders").delete().eq("center_id", centerAId).eq("product_id", productId);
});

test("직접결제를 고르면 PG 없이 주문만 접수되고, 이용권은 발급되지 않는다 (실브라우저)", async ({ page }) => {
  const admin = getFixtureAdminClient();
  // 이 프로필의 이 상품에 대한 기존 주문이 있으면 이번 실행 결과와 섞여 오탐할 수 있으므로 먼저 정리
  await admin.from("orders").delete().eq("center_id", centerAId).eq("product_id", productId).eq("profile_id", userA.profileId);

  await page.goto(`/checkout?center=${centerAId}&product=${productId}`);
  await expect(page.locator(".checkout-pay-btn")).toBeVisible({ timeout: 15000 });

  await page.locator(".pay-method", { hasText: "직접결제" }).click();
  await expect(page.locator(".perm-guide", { hasText: "결제 없이 주문만 접수돼요" })).toBeVisible();

  await page.locator(".checkout-pay-btn").click();
  await expect(page.locator(".checkout-done-title", { hasText: "주문이 접수됐어요" })).toBeVisible({ timeout: 15000 });
  await expect(page.locator(".checkout-done-sub", { hasText: "센터에 방문하거나 연락해 결제를 완료해주세요" })).toBeVisible();

  const { data: orders, error } = await admin
    .from("orders")
    .select("id, status, pay_method, payment_provider, product_id, profile_id")
    .eq("center_id", centerAId).eq("product_id", productId).eq("profile_id", userA.profileId);
  if (error) throw new Error(`주문 조회 실패: ${error.message}`);
  expect(orders ?? []).toHaveLength(1);
  const order = orders![0];
  expect(order.status).toBe("pending");
  expect(order.pay_method).toBe("direct");
  expect(order.payment_provider).toBeNull();

  const { data: memberships, error: memErr } = await admin
    .from("memberships").select("id").eq("profile_id", userA.profileId).eq("product_id", productId);
  if (memErr) throw new Error(`수강권 조회 실패: ${memErr.message}`);
  expect(memberships ?? []).toHaveLength(0);
});
