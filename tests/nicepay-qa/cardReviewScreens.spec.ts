import { test, expect, openAs, setGate, control, callCount, shot, reviewProduct, reviewCenter, orderRows, membershipsOf, cleanNicepayOrders, sessionFor, installMockSdk, BASE, SDK_URL } from "./helpers";
import type { Browser, Page } from "@playwright/test";

/* NICEPAY 카드사 심사 화면 점검(2026-10-30) — 격리 스택·모의 SDK(실제 NICEPAY 호출 0건). 데스크톱 1440×900 / 모바일 390×844, 라이트 모드.
   실행: NPQA_ADDRESS_FLAG=false(배포 기본값=꺼짐)로 서버를 띄운다 → 푸터·상품 화면 어디에도 사업장 주소가 찍히지 않는다. /legal/business 는 주소를 항상 보여 주는 기존 페이지라 스크린샷을 남기지 않는다(텍스트만 단언).
   스크린샷 이름: card-review/<번호>-<화면>-<desktop|mobile>.png */
test.describe.configure({ mode: "serial" });
const VIEWS = { desktop: { width: 1440, height: 900 }, mobile: { width: 390, height: 844 } } as const;
type V = keyof typeof VIEWS;
const ADDRESS_FLAG_OFF = process.env.NPQA_ADDRESS_FLAG === "false";
const guard = () => test.skip(!ADDRESS_FLAG_OFF, "NPQA_ADDRESS_FLAG=false 로 실행해야 해요(주소가 스크린샷에 찍히지 않게)");
const ctxOf = async (browser: Browser, v: V, who?: "A" | "B") => browser.newContext({ viewport: VIEWS[v], colorScheme: "light", isMobile: v === "mobile", hasTouch: v === "mobile", ...(who ? { storageState: await sessionFor(browser, who) } : {}) });
const text = async (p: Page) => (await p.locator("body").innerText()).replace(/\s+/g, " ");
const snap = (p: Page, n: string, v: V) => shot(p, `card-review/${n}-${v}`);
const noHorizontalOverflow = async (p: Page) => expect(await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);

test.beforeAll(() => { setGate("off"); cleanNicepayOrders(); control({}); });
test.afterAll(() => { setGate("off"); });

for (const v of ["desktop", "mobile"] as V[]) {
  test(`[${v}] 법적 고지 — 약관 제9조·환불 4항·처리위탁 표: 현재 PG=NICEPAY, 과거 거래=토스페이먼츠, 카카오페이/토스페이 단정 없음`, async ({ browser }) => {
    guard(); const ctx = await ctxOf(browser, v); const page = await ctx.newPage();
    await page.goto(`${BASE}/legal/terms`); await page.waitForLoadState("networkidle");
    let t = await text(page);
    expect(t).toContain("결제대행사(NICEPAY)"); expect(t).toContain("과거 토스페이먼츠를 통해 결제된 거래의 취소·환불"); expect(t).not.toMatch(/카카오페이|토스페이(?!먼츠)/);
    await page.getByRole("heading", { name: /제9조/ }).scrollIntoViewIfNeeded(); await snap(page, "01-legal-terms-article9", v); await noHorizontalOverflow(page);
    await page.goto(`${BASE}/legal/refund`); await page.waitForLoadState("networkidle"); t = await text(page);
    expect(t).toContain("현재 NICEPAY"); expect(t).toContain("토스페이먼츠"); expect(t).not.toMatch(/카카오페이|토스페이(?!먼츠)/);
    await page.getByRole("heading", { name: /4\. 결제수단별 환불 처리/ }).scrollIntoViewIfNeeded(); await snap(page, "02-legal-refund-section4", v); await noHorizontalOverflow(page);
    await page.goto(`${BASE}/legal/privacy`); await page.waitForLoadState("networkidle"); t = await text(page);
    expect(t).toMatch(/NICEPAY\s*온라인 PG\(신용카드\) 결제 기능 활성화 시/); expect(t).toMatch(/토스페이먼츠\s*과거 토스페이먼츠로 결제된 거래의 조회·취소·환불 처리/);
    await page.getByRole("heading", { name: /5\. 개인정보 처리의 위탁/ }).scrollIntoViewIfNeeded(); await snap(page, "03-legal-privacy-delegation", v); await noHorizontalOverflow(page);
    // 사업자 정보: 텍스트만 단언(스크린샷 없음 — 이 페이지는 사업장 주소를 항상 표시하는 기존 페이지)
    await page.goto(`${BASE}/legal/business`); await page.waitForLoadState("networkidle"); t = await text(page);
    expect(t).toContain("결제대행사(NICEPAY)"); expect(t).toContain("온라인 결제 수단은 서비스 준비 상황에 따라 제공되고");
    await ctx.close();
  });

  test(`[${v}] 홈·/products — 주소 플래그 꺼짐(기본): 주소 미표시, 상품명·가격·횟수·이용기간·환불정책 링크 표시`, async ({ browser }) => {
    guard(); const ctx = await ctxOf(browser, v); const page = await ctx.newPage();
    const { BUSINESS_ADDRESS } = await import("../../lib/businessAddress"); const { BUSINESS_INFO } = await import("../../lib/businessInfo");
    await page.goto(`${BASE}/`); await page.waitForLoadState("networkidle"); await page.locator(".home-footer").scrollIntoViewIfNeeded();
    const home = await text(page); expect(home.includes(BUSINESS_ADDRESS), "홈 푸터에 주소 없음(플래그 꺼짐)").toBe(false);
    expect(home).toContain(BUSINESS_INFO.businessRegNo); expect(home).toContain(BUSINESS_INFO.mailOrderRegNo); expect(home).toContain("환불·취소 정책");
    await snap(page, "04-home-footer", v);
    await page.goto(`${BASE}/products`); await page.waitForLoadState("networkidle"); await page.waitForTimeout(1500);
    const t = await text(page); expect(t.includes(BUSINESS_ADDRESS), "/products 에 주소 없음(플래그 꺼짐)").toBe(false);
    const rows = page.locator(".center-product-row"); const n = await rows.count(); expect(n).toBeGreaterThan(0);
    for (let i = 0; i < n; i++) {
      const r = (await rows.nth(i).innerText()).replace(/\s+/g, " ");
      expect(r, `상품 ${i + 1}: 이름·가격(원)`).toMatch(/\S+.*[\d,]+원/); expect(r, `상품 ${i + 1}: 횟수 또는 구분`).toMatch(/수강권|상품/);
      expect(r, `상품 ${i + 1}: 이용기간(사전예약·서비스 제공기간)`).toMatch(/사전예약기간/); expect(r).toMatch(/서비스 제공기간/);
    }
    await expect(page.getByTestId("products-purchase-guide").getByRole("link", { name: "환불·취소 정책" })).toBeVisible();
    await expect(page.locator(".home-footer-links").getByRole("link", { name: "환불·취소 정책" })).toBeVisible();
    await snap(page, "05-public-products", v); await noHorizontalOverflow(page);
    await ctx.close();
  });
}

for (const v of ["desktop", "mobile"] as V[]) {
  test(`[${v}] 심사관 로그인 → 심사 센터 상품 선택 → 결제 화면 → (모의)결제창 → 완료 — 외부 호출 0건`, async ({ browser }) => {
    guard(); setGate("reviewer"); control({}); cleanNicepayOrders();
    const ctx = await ctxOf(browser, v, "B"); const page = await ctx.newPage(); const external: string[] = [];
    page.on("request", (r) => { if (r.url() === SDK_URL) return; const h = new URL(r.url()).hostname; if (!["localhost", "127.0.0.1"].includes(h)) external.push(h); });
    await installMockSdk(page, "success");
    const P1 = reviewProduct("1회"); const before = membershipsOf(P1); const approvesBefore = callCount("APPROVE");   // 호출 로그는 실행 전체에서 누적 → 이 시험이 만든 호출만 센다
    await page.goto(`${BASE}/center/${reviewCenter()}?buy=1`); await page.waitForLoadState("networkidle");
    const row = page.locator(".center-product-row").filter({ hasText: "1회 이용권 (심사용)" }); await expect(row).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(".center-product-row").filter({ hasText: "5회 이용권 (심사용)" })).toBeVisible(); await expect(page.locator(".center-product-row").filter({ hasText: "10회 이용권 (심사용)" })).toBeVisible();
    const list = (await text(page)); expect(list).toMatch(/15,000원/); expect(list).toMatch(/60,000원/); expect(list).toMatch(/110,000원/); expect(list).toMatch(/실제 수업·서비스 제공 없음|심사용/);
    await snap(page, "06-reviewer-center-products", v);
    await row.getByRole("button", { name: "구매" }).click(); await page.waitForURL(/\/checkout/, { timeout: 20_000 }); await page.waitForLoadState("networkidle");
    await expect(page.locator(".pay-method", { hasText: /카드/ }).first()).toBeVisible();
    const co = await text(page); expect(co).toContain("사전예약기간"); expect(co).toContain("서비스 제공기간"); expect(co).toContain("환불 정책");
    await snap(page, "07-reviewer-checkout", v); await noHorizontalOverflow(page);
    await page.locator(".checkout-pay-btn").first().click(); await page.waitForURL(/\/checkout\/nicepay\/result/, { timeout: 30_000 });
    await expect(page.getByText("결제가 완료됐어요.")).toBeVisible({ timeout: 30_000 }); await snap(page, "08-reviewer-result-done", v);
    expect(callCount("APPROVE") - approvesBefore).toBe(1); expect(membershipsOf(P1)).toBe(before + 1);
    expect(orderRows("B").split(",").filter((r) => r.includes(":done:nicepay")).length).toBe(1);
    expect(external, `외부(비로컬) 요청 0건: ${JSON.stringify(external)}`).toEqual([]);
    setGate("off"); await ctx.close();
  });
}

test("[결제 OFF 유지] 일반 회원 A — 게이트 off 에서는 카드(NICEPAY) 미노출·직접결제만, 결제창 호출 0", async ({ browser }) => {
  guard(); setGate("off"); control({}); const approvesBefore = callCount("APPROVE"); const { ctx, page } = await openAs(browser, "A", "success");
  await page.goto(`${BASE}/center/${reviewCenter()}?buy=1`); await page.waitForLoadState("networkidle");
  expect((await text(page)).includes("1회 이용권 (심사용)"), "일반 회원에게 심사 센터 상품이 보이지 않는다").toBe(false);
  expect(callCount("APPROVE") - approvesBefore, "승인 호출 0").toBe(0); await ctx.close();
});
