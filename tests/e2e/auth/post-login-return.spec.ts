import { test, expect } from "@playwright/test";
import {
  loadTestAccountMeta,
  getOrCreateOwnedTestCenter,
  getOrCreateTestPassProductNamed,
  type TestUser,
} from "../fixtures/testData";
import { getFixtureAdminClient } from "../../integration/setup";

/*
  로그인 후 하던 작업 이어가기(lib/postLoginReturn.ts) 회귀 테스트.

  배경: 비로그인 상태로 결제/장바구니/예약 등을 시도하면 "로그인이 필요해요" 에러만 뜨고
  로그인 화면으로 갈 방법이 없었다(사용자 스크린샷 피드백, 2026-08-31). "로그인 하러 가기"
  버튼을 추가했는데, 로그인 완료 후 항상 홈으로만 돌아가 원래 하던 작업을 처음부터 다시
  해야 하는 문제가 또 있어(같은 날 후속 피드백) lib/postLoginReturn.ts로 일반화했다.

  이 파일은 이메일 로그인 계정(TEST_USER_A)으로 실제 왕복을 화면마다 검증한다. 소셜
  로그인(구글/카카오/네이버/애플)은 외부 provider라 CI에서 실제 왕복을 자동화할 수 없어
  범위 밖 — 다섯 갈래가 전부 동일한 홈("/") 착지점에 모이므로, 이메일 경로가 그 착지점의
  실제 이동 로직(app/page.tsx)을 그대로 검증한다는 점에서 다른 네 갈래도 같은 코드 경로를
  탄다(대표성 있음).

  각 시나리오는 비로그인 컨텍스트(storageState 없음)로 새로 만든다 — 로그인/로그아웃을
  반복하면 다른 파일들이 공유하는 storageState 세션과 꼬일 수 있어, 이 파일 전용 컨텍스트를
  매번 새로 연다(다른 e2e 파일과 세션 격리).
*/

let managerA: TestUser;
let userA: TestUser;
let centerAId: string;
let productId: string;
const PRODUCT_NAME = "E2E 로그인복귀 테스트 수강권";

test.beforeAll(async () => {
  managerA = loadTestAccountMeta("manager-a");
  userA = loadTestAccountMeta("user-a");
  centerAId = await getOrCreateOwnedTestCenter(managerA);
  const product = await getOrCreateTestPassProductNamed(centerAId, PRODUCT_NAME);
  productId = product.id;
});

test.afterAll(async () => {
  // "장바구니 담기" 시나리오가 실제로 성공시킨 cart_items 행 정리(다음 실행에 남지 않게)
  const admin = getFixtureAdminClient();
  await admin.from("cart_items").delete().eq("profile_id", userA.profileId).eq("product_id", productId);
});

async function loginWithEmail(page: import("@playwright/test").Page) {
  await page.locator('input[type="email"]').fill(process.env.TEST_USER_A_EMAIL!);
  await page.locator('input[type="password"]').fill(process.env.TEST_USER_A_PASSWORD!);
  await page.locator(".login-submit").click();
}

test.describe("로그인 필요 → 로그인 → 원래 화면 복귀", () => {
  test("결제 화면: 비로그인으로 결제 시도 → 로그인 → 같은 상품의 결제 화면으로 정확히 복귀 (실브라우저)", async ({ browser }) => {
    const context = await browser.newContext(); // 비로그인 컨텍스트
    const page = await context.newPage();

    const checkoutUrl = `/checkout?center=${centerAId}&product=${productId}`;
    await page.goto(checkoutUrl);
    await expect(page.locator(".checkout-pay-btn")).toBeVisible({ timeout: 15000 });

    await page.locator(".checkout-pay-btn").click();
    const loginBtn = page.locator(".error-toast-action");
    await expect(loginBtn).toBeVisible({ timeout: 10000 });
    await expect(loginBtn).toHaveText("로그인 하러 가기");

    const href = await loginBtn.getAttribute("href");
    expect(href).toBe(`/login?next=${encodeURIComponent(checkoutUrl)}`);

    await loginBtn.click();
    await page.waitForURL(/\/login\?next=/);
    await loginWithEmail(page);

    await page.waitForURL((u) => u.pathname === "/checkout", { timeout: 15000 });
    expect(new URL(page.url()).search).toBe(`?center=${centerAId}&product=${productId}`);
    // 복귀 후에도 정상적으로 결제 화면이 그 상품으로 다시 로드됐는지(빈 화면/에러 아님)
    await expect(page.locator(".checkout-pay-btn")).toBeVisible({ timeout: 15000 });

    await context.close();
  });

  test("장바구니 담기: 비로그인으로 센터 상세에서 '담기' 시도 → 로그인 → 같은 센터 화면으로 복귀 (실브라우저)", async ({ browser }) => {
    // fetchCart() 자체는 RLS가 조용히 빈 배열을 돌려줘 /cart를 그냥 열람하는 것만으로는
    // 에러가 안 난다(실측 확인) — 실제로 "로그인이 필요해요"가 뜨는 지점은 센터 상세
    // 화면에서 상품을 "담기"할 때(handleAddCart → addToCart → myProfileId())다.
    const context = await browser.newContext();
    const page = await context.newPage();

    const centerUrl = `/center/${centerAId}?buy=1`;
    await page.goto(centerUrl);
    const cartBtn = page.locator(".center-product-row", { hasText: PRODUCT_NAME }).locator(".center-product-cart");
    await expect(cartBtn).toBeVisible({ timeout: 15000 });
    await cartBtn.click();

    const loginBtn = page.locator(".error-toast-action");
    await expect(loginBtn).toBeVisible({ timeout: 10000 });

    const href = await loginBtn.getAttribute("href");
    expect(href).toBe(`/login?next=${encodeURIComponent(centerUrl)}`);

    await loginBtn.click();
    await page.waitForURL(/\/login\?next=/);
    await loginWithEmail(page);

    await page.waitForURL((u) => u.pathname === `/center/${centerAId}`, { timeout: 15000 });
    expect(new URL(page.url()).search).toBe("?buy=1");
    // 로그인된 상태로 돌아왔으니 이제는 실제로 담기가 성공해야 한다
    await expect(cartBtn).toBeVisible({ timeout: 15000 });
    await cartBtn.click();
    await expect(page.locator(".toast", { hasText: "장바구니에 담았어요" })).toBeVisible({ timeout: 10000 });

    await context.close();
  });

  test("예약 화면: 비로그인으로 /reservation 진입 → 로그인 → /reservation으로 복귀 (실브라우저)", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto("/reservation");
    // 2026-09-04: 전용 CSS 없이 방치돼 있던 auth-required-state를 앱 전역 공용
    // EmptyState 컴포넌트(app/components/EmptyState.tsx)로 교체 — 타이틀은 <b>,
    // 액션 버튼은 .app-empty-action 안에 렌더링됨.
    await expect(page.locator(".app-empty-state b")).toHaveText("로그인이 필요해요", { timeout: 15000 });
    const loginBtn = page.locator(".app-empty-action .primary-btn");
    await expect(loginBtn).toHaveText("로그인하고 계속하기");

    const href = await loginBtn.getAttribute("href");
    expect(href).toBe(`/login?next=${encodeURIComponent("/reservation")}`);

    await loginBtn.click();
    await page.waitForURL(/\/login\?next=/);
    await loginWithEmail(page);

    await page.waitForURL((u) => u.pathname === "/reservation", { timeout: 15000 });
    // 로그인된 상태로 돌아왔으니 "로그인이 필요해요" 상태가 더는 아니어야 한다(캘린더가 보임)
    await expect(page.locator(".app-empty-state")).toHaveCount(0, { timeout: 15000 });
    await expect(page.locator(".booking-steps")).toBeVisible();

    await context.close();
  });

  test("next 없이 곧바로 /login 방문 후 로그인하면 여전히 홈으로 이동한다 (회귀 확인, 실브라우저)", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto("/login");
    await loginWithEmail(page);

    await page.waitForURL((u) => u.pathname === "/", { timeout: 15000 });
    expect(page.url()).toMatch(/\/$/);

    await context.close();
  });
});
