import { test, expect, openAs, setGate, control, shot, psql, BASE, cleanNicepayOrders, gotoCheckout } from "./helpers";

/* NICEPAY 심사관에게 "지정한 실제 센터"를 보여 주는 허용 목록(add_nicepay_review_real_center_grants_20261103.sql)의 브라우저 시험 — 로컬 격리 스택, 모의 NICEPAY(호출 0).
   사전: setupRealCenter.sh 로 허용 SQL·'[로컬] 실센터 모사' 시험 데이터 준비. 실행: NPQA_REAL_CENTER=1 scripts/isolated/nicepayQa/run.sh tests/nicepay-qa/realCenter.spec.ts */
test.describe.configure({ mode: "serial" });
test.skip(process.env.NPQA_REAL_CENTER !== "1", "NPQA_REAL_CENTER=1 로 실행");
const REAL_NAME = "[로컬] 실센터 모사", OP_NAME = "[QA] 심사 시험 스튜디오";
const ACTIVE = ["[로컬] 11월 스케줄링 수강권", "[로컬] 11월 요일고정 수강권", "[로컬] 11월 4주완성 수강권"], EXPIRED = "[로컬] 10월 수강권(만료)";
const centerId = (name: string) => psql(`select id from centers where name='${name}'`);
const accB = () => psql(`select a.id from accounts a join auth.users u on u.id=a.auth_id where u.email='${process.env.TEST_USER_B_EMAIL}'`);
const grant = (purchase: boolean | null) => psql(purchase === null ? "delete from nicepay_review_center_grants" : `delete from nicepay_review_center_grants; insert into nicepay_review_center_grants(account_id, center_id, can_purchase, note) values ('${accB()}','${centerId(REAL_NAME)}',${purchase},'브라우저 시험')`);
const realOrders = () => Number(psql(`select count(*) from orders where center_id='${centerId(REAL_NAME)}'`));
test.beforeAll(() => { setGate("off"); cleanNicepayOrders(); control({}); grant(null); });
test.afterAll(() => { grant(null); setGate("off"); cleanNicepayOrders(); });

test("[허용 전] 심사관B: 홈에 심사 센터만, 실제 센터·운영 센터는 안 보임(기존 동작)", async ({ browser }) => {
  const { ctx, page } = await openAs(browser, "B", "close"); await page.goto(`${BASE}/`); await page.waitForLoadState("networkidle");
  await expect(page.getByText("MWHABIT NICEPAY 카드사 심사 환경").first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(REAL_NAME)).toHaveCount(0); await expect(page.getByText(OP_NAME)).toHaveCount(0);
  await page.goto(`${BASE}/products`); await page.waitForLoadState("networkidle"); for (const n of ACTIVE) await expect(page.getByText(n)).toHaveCount(0);
  await shot(page, "real-center-0-before-grant"); await ctx.close();
});

test("[조회 허용] 심사관B: 홈에 실제 센터 노출, /products 에 11월 수강권 3종(만료 10월 제외·운영 센터 제외), 센터 상세에 가격·횟수", async ({ browser }) => {
  grant(false); const { ctx, page } = await openAs(browser, "B", "close");
  await page.goto(`${BASE}/`); await page.waitForLoadState("networkidle");
  await expect(page.getByText(REAL_NAME).first()).toBeVisible({ timeout: 20_000 }); await expect(page.getByText("MWHABIT NICEPAY 카드사 심사 환경").first()).toBeVisible(); await expect(page.getByText(OP_NAME)).toHaveCount(0);
  await page.goto(`${BASE}/products`); await page.waitForLoadState("networkidle");
  for (const n of ACTIVE) await expect(page.getByText(n).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(EXPIRED)).toHaveCount(0); await expect(page.getByText(OP_NAME)).toHaveCount(0);
  await shot(page, "real-center-1-products");
  await page.goto(`${BASE}/center/${centerId(REAL_NAME)}?buy=1`); await page.waitForLoadState("networkidle");
  await expect(page.locator(".center-product-row")).toHaveCount(3, { timeout: 20_000 });
  const body = await page.locator("body").innerText();
  for (const price of ["80,000원", "320,000원"]) expect(body, price).toContain(price);   // 가격 표시가 DB 값과 일치(단일 320,000 · 선택형 최저 80,000)
  expect(body).toContain("횟수");   // 횟수 선택 UI
  // 조회 전용: 상품명·가격·이용조건은 보이고, 구매·담기·장바구니·예약 버튼과 "구매 가능" 안내는 없다
  await expect(page.getByTestId("view-only-notice")).toBeVisible();
  await expect(page.locator(".center-product-buy")).toHaveCount(0); await expect(page.locator(".center-product-cart")).toHaveCount(0);
  await expect(page.locator(".cart-link-btn")).toHaveCount(0); expect(body).not.toContain("바로 구매하거나 장바구니에 담을 수 있어요"); expect(body).toContain("수강권 · 상품 안내");
  await expect(page.locator(".center-product-period").first()).toBeVisible();   // 이용기간 안내는 그대로
  await page.locator(".sheet-close-btn").click();
  await expect(page.getByRole("button", { name: "수강권 안내 보기" })).toBeVisible(); await expect(page.getByRole("button", { name: "수강권 구매하기" })).toHaveCount(0); await expect(page.getByRole("button", { name: "예약하기" })).toHaveCount(0);
  await shot(page, "real-center-2-center-page"); await ctx.close();
});

test("[조회 허용] 직접 URL 로 결제 화면에 들어와도 안내만 보이고 결제 버튼이 비활성 — 주문이 만들어지지 않는다(결제 아님)", async ({ browser }) => {
  const { ctx, page } = await openAs(browser, "B", "close"); const before = realOrders();
  const pid = psql(`select id from products where name='${ACTIVE[2]}'`);
  await gotoCheckout(page, pid, centerId(REAL_NAME));
  await expect(page.getByTestId("view-only-notice")).toBeVisible({ timeout: 20_000 });
  const pay = page.locator(".checkout-pay-btn").first(); await expect(pay).toBeDisabled(); await expect(pay).toContainText("조회 전용");
  await pay.click({ force: true }).catch(() => {}); await page.waitForTimeout(1500);
  expect(realOrders()).toBe(before);   // 주문 행 0 증가
  await expect(page.getByText("320,000원").first()).toBeVisible();   // 가격·이용조건은 그대로 확인 가능
  await shot(page, "real-center-3-view-only-checkout"); await ctx.close();
});

test("[구매 허용] can_purchase=true 이면 구매·담기 버튼과 예약 버튼이 보이고 결제 화면 버튼이 활성", async ({ browser }) => {
  grant(true); const { ctx, page } = await openAs(browser, "B", "close");
  await page.goto(`${BASE}/center/${centerId(REAL_NAME)}?buy=1`); await page.waitForLoadState("networkidle");
  await expect(page.locator(".center-product-buy").first()).toBeVisible({ timeout: 20_000 }); await expect(page.getByTestId("view-only-notice")).toHaveCount(0);
  await page.locator(".sheet-close-btn").click(); await expect(page.getByRole("button", { name: "예약하기" })).toBeVisible();
  const pid = psql(`select id from products where name='${ACTIVE[2]}'`); await gotoCheckout(page, pid, centerId(REAL_NAME));
  await expect(page.getByTestId("view-only-notice")).toHaveCount(0); await expect(page.locator(".checkout-pay-btn").first()).toBeEnabled({ timeout: 20_000 });
  await ctx.close();
});

test("[일반 회원] 홈·상품 목록·센터 화면이 기존과 동일: 구매 버튼 보임, 안내 문구 없음, 심사 센터는 안 보임", async ({ browser }) => {
  grant(true); const { ctx, page } = await openAs(browser, "A", "close");
  await page.goto(`${BASE}/center/${centerId(REAL_NAME)}?buy=1`); await page.waitForLoadState("networkidle");
  await expect(page.locator(".center-product-buy").first()).toBeVisible({ timeout: 20_000 }); await expect(page.locator(".center-product-cart").first()).toBeVisible(); await expect(page.getByTestId("view-only-notice")).toHaveCount(0);
  expect(await page.locator("body").innerText()).toContain("수강권 · 상품 구매");
  await page.goto(`${BASE}/products`); await page.waitForLoadState("networkidle");
  for (const n of ACTIVE) await expect(page.getByText(n).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(EXPIRED)).toHaveCount(0); await expect(page.getByText("MWHABIT NICEPAY 카드사 심사 환경")).toHaveCount(0);
  await shot(page, "real-center-4-general-member-products"); await ctx.close();
});

test("[허용 해제] 해제 후 심사관B 에게 실제 센터가 다시 숨겨진다", async ({ browser }) => {
  grant(null); const { ctx, page } = await openAs(browser, "B", "close"); await page.goto(`${BASE}/products`); await page.waitForLoadState("networkidle");
  for (const n of ACTIVE) await expect(page.getByText(n)).toHaveCount(0);
  await ctx.close();
});
