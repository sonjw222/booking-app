import { test, expect } from "@playwright/test";
import { loadTestAccountMeta, getOrCreateOwnedTestCenter, getOrCreateTestPassProductNamed, type TestUser } from "../fixtures/testData";
import { getFixtureAdminClient } from "../../integration/setup";
import { MEMBER_AUTH_FILE } from "../fixtures/authFiles";

/*
  실제 토스 결제창이 열리는 지점까지의 회귀 확인 (카드 결제).

  이 dev 환경은 .env.local에 NEXT_PUBLIC_PAYMENT_PROVIDER=toss가 실제로 켜져 있다(Mock이
  아님) — 카드/카카오페이/토스페이/계좌이체를 고르면 실제 토스 v2 SDK가 브라우저를 진짜
  결제 게이트웨이(payment-gateway-sandbox.tosspayments.com)로 이동시킨다. 카드번호를 직접
  입력해 끝까지 승인시키는 것은 이 세션에서 의도적으로 자동화 범위 밖으로 뒀다(iframe 기반
  폼이라 자동화가 불안정하고, 실제 승인은 사람이 한 번 수동 확인하는 게 더 안전 — 이전
  대화에서 결정됨) — 이 스펙은 딱 그 경계선(결제창이 실제로 열리는지)까지만 자동 검증한다.

  결제 금액이 0원이면 토스 SDK 자체가 즉시 거부하므로(실측 확인: "금액은 0보다 커야
  합니다"), 이 테스트 전용 상품에 admin으로 실제 가격을 부여한다(다른 E2E 상품 픽스처는
  가격 없이도 되는 Mock/직접결제 전용이라 이 문제가 없었음).
*/

test.use({ storageState: MEMBER_AUTH_FILE });

let managerA: TestUser;
let centerAId: string;
let productId: string;
const PRODUCT_NAME = "E2E 실토스결제창 테스트 수강권";

test.beforeAll(async () => {
  managerA = loadTestAccountMeta("manager-a");
  centerAId = await getOrCreateOwnedTestCenter(managerA);
  const product = await getOrCreateTestPassProductNamed(centerAId, PRODUCT_NAME);
  productId = product.id;
  const admin = getFixtureAdminClient();
  await admin.from("products").update({ price: 10000 }).eq("id", productId);
});

test.afterAll(async () => {
  const admin = getFixtureAdminClient();
  await admin.from("orders").delete().eq("center_id", centerAId).eq("product_id", productId);
});

test("카드 결제를 시도하면 실제 토스 결제 게이트웨이로 이동한다 (실브라우저, 카드입력 전까지)", async ({ page }) => {
  await page.goto(`/checkout?center=${centerAId}&product=${productId}`);
  await expect(page.locator(".checkout-pay-btn")).toBeVisible({ timeout: 15_000 });
  // 기본 결제수단은 "card"(신용/체크카드) — 별도 선택 없이 바로 결제 시도
  await page.locator(".checkout-pay-btn").click();
  // requestPayment() 성공 시 페이지 자체가 이동하는 게 아니라(실측 확인, 문서 주석과 다름),
  // 토스 v2 SDK가 현재 페이지 위에 실제 결제 게이트웨이를 cross-origin iframe 오버레이로
  // 띄운다 — 결제 완료 후에야 successUrl/failUrl로 진짜 페이지 이동이 일어난다. 텍스트는
  // cross-origin이라 page.getByText()로 못 읽으므로(별도 frameLocator 필요, 텍스트 매칭은
  // 깨지기 쉬움), 실제 토스 도메인 iframe이 떴는지 자체로 확인한다 — 화면 캡처로 실측
  // 확인된 결제수단 선택 오버레이("결제 방법을 선택해주세요")와 정확히 일치.
  const gatewayFrame = page.locator('iframe[src*="tosspayments.com"]');
  await expect(gatewayFrame).toBeVisible({ timeout: 20_000 });
});
