import { test, expect } from "@playwright/test";
import { loadTestAccountMeta, getOrCreateOwnedTestCenter, getOrCreateTestPassProductNamed, type TestUser } from "../fixtures/testData";
import { getFixtureAdminClient } from "../../integration/setup";
import { MEMBER_AUTH_FILE } from "../fixtures/authFiles";

/*
  실제 토스 결제창이 열리는 지점까지의 회귀 확인 (카드 결제).

  이 로컬 dev 환경은 .env.local에 NEXT_PUBLIC_PAYMENT_PROVIDER=toss가 실제로 켜져 있다
  (Mock이 아님) — 카드/카카오페이/토스페이/계좌이체를 고르면 실제 토스 v2 SDK가 브라우저에
  진짜 결제 게이트웨이(payment-gateway-sandbox.tosspayments.com)를 cross-origin iframe으로
  띄운다. 카드번호를 직접 입력해 끝까지 승인시키는 것은 이 세션에서 의도적으로 자동화 범위
  밖으로 뒀다(iframe 기반 폼이라 자동화가 불안정하고, 실제 승인은 사람이 한 번 수동 확인하는
  게 더 안전 — 이전 대화에서 결정됨) — 이 스펙은 딱 그 경계선(결제창이 실제로 열리는지)까지만
  자동 검증한다.

  ⚠ GitHub Actions CI는 NEXT_PUBLIC_TOSS_CLIENT_KEY/NEXT_PUBLIC_PAYMENT_PROVIDER를 secrets로
  주입하지 않는다(.github/workflows/*.yml 확인 — 의도적으로: CI가 실제 결제 게이트웨이에
  반복 접속하는 건 바람직하지 않음) — CI 빌드는 항상 기본값인 mock provider로 동작해
  이 iframe이 절대 뜨지 않는다. 처음엔 `process.env.NEXT_PUBLIC_PAYMENT_PROVIDER`로 미리
  걸러보려 했는데, 이 값은 Playwright가 띄우는 Next.js dev 서버(별도 자식 프로세스, .env.local을
  직접 읽음) 안에서만 유효하고 Playwright 테스트 러너 자신의 Node 프로세스에는 안 실려있어
  (실측 확인: 로컬 dev 환경에서도 undefined) 이 방식으론 항상 건너뛰어져 버렸다 — 그래서
  환경변수를 미리 읽지 않고, 실제로 결제 버튼을 눌러본 뒤 어느 화면이 뜨는지로 판단한다.

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
  // 이 환경이 mock provider면(CI 등, provider=toss가 아님) 카드 클릭이 실제 게이트웨이 없이
  // 곧바로 완료 화면으로 끝난다 — 두 가능한 결과 중 무엇이 왔는지로 이 환경의 provider를
  // 사후 판단하고, mock이면 조용히 건너뛴다(환경변수를 미리 못 읽는 이유는 파일 상단 참고).
  const mockDone = page.locator(".checkout-done-title");
  await expect(gatewayFrame.or(mockDone)).toBeVisible({ timeout: 20_000 });
  test.skip(await mockDone.isVisible(), "이 환경은 mock 결제 provider로 동작 중이라(CI 등) 실제 토스 게이트웨이를 검증할 수 없음");
  await expect(gatewayFrame).toBeVisible();
});
