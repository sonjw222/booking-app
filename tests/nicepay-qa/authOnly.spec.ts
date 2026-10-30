import { test, expect, openAs, setGate, control, callCount, calls, shot, reviewProduct, reviewCenter, productPrice, orderRows, membershipsOf, cleanNicepayOrders, formsOf, gotoCheckout, need, BASE } from "./helpers";
import type { Page } from "@playwright/test";

/* NICEPAY 격리 QA — 인증만(auth-only): 결제창을 열고 닫고, 인증 결과가 돌아와도 **승인 API 는 한 번도 나가지 않는다**(실제 NICEPAY 호출 0, 운영 DB 0). 모의 SDK(goPay 대체) + fetch 가로채기 모의 서버.
   실행: NPQA_AUTH_ONLY=1 scripts/isolated/nicepayQa/run.sh tests/nicepay-qa/authOnly.spec.ts  (서버는 MID=nicepay00m + NICEPAY_QA_AUTH_ONLY=true 로 뜬다 — 키는 무작위 가짜 값).
   이 시험은 "모의 결제창" 결과다. 실제 NICEPAY 외부 결제창(실창) 확인은 별도(docs/payments/NICEPAY_AUTH_ONLY_QA_20261030.md, 테스트 MerchantKey 필요 — BLOCKED 항목). */
test.describe.configure({ mode: "serial" });
const ON = process.env.NPQA_AUTH_ONLY === "1";
test.skip(!ON, "NPQA_AUTH_ONLY=1 로 실행해야 해요(서버가 auth-only 설정이어야 함)");

const PRODUCTS = ["1회", "4주", "3개월"];
const lastOrder = () => { const rows = orderRows("B").split(",").filter(Boolean); const r = rows[rows.length - 1]; return r ? { id: r.split(":")[0], status: r.split(":")[1] } : null; };
const pay = (p: Page) => p.locator(".checkout-pay-btn").first();
const moneyCalls = () => calls().filter((c) => ["APPROVE", "NETCANCEL", "BLOCKED_EXTERNAL"].includes(String(c.kind))).length;

test.beforeAll(() => { setGate("off"); cleanNicepayOrders(); control({}); });
test.afterAll(() => { setGate("off"); cleanNicepayOrders(); });

test("[설정] 서버는 공용 테스트 MID 로 auth-only 로 떠 있다 — 운영 MID 아님, 브라우저에 키 없음", async ({ browser }) => {
  expect(need("NICEPAY_MID")).toBe("nicepay00m"); expect(need("NICEPAY_MID")).not.toMatch(/^mwhabit0[12]m$/);
  expect(process.env.NICEPAY_QA_AUTH_ONLY).toBe("true"); expect(need("NEXT_PUBLIC_SUPABASE_URL")).toMatch(/^http:\/\/(127\.0\.0\.1|localhost)/);   // 로컬 격리 DB(운영 아님)
  setGate("reviewer"); const { ctx, page } = await openAs(browser, "B", "close");
  const html = await (await page.request.get(`${BASE}/`)).text(); expect(html).not.toContain(need("NICEPAY_MERCHANT_KEY"));
  await ctx.close();
});

test("[심사관] 로그인 → 심사 센터 접근 → 수강권 3개 접근 → 카드 결제수단 표시 → 금액 = 상품 가격", async ({ browser }) => {
  setGate("reviewer"); control({}); const { ctx, page } = await openAs(browser, "B", "close");
  await page.goto(`${BASE}/center/${reviewCenter()}?buy=1`); await page.waitForLoadState("networkidle");
  await expect(page.locator(".center-product-row").first()).toBeVisible({ timeout: 20_000 });
  for (const n of PRODUCTS) {
    const id = reviewProduct(n); expect(id, `심사 상품 ${n}`).not.toBe("");
    await gotoCheckout(page, id);
    await expect(page.locator(".pay-method", { hasText: /카드/ }).first()).toBeVisible();
    const price = productPrice(id); await expect(page.getByText(new Intl.NumberFormat("ko-KR").format(price) + "원").first()).toBeVisible();
  }
  await shot(page, "auth-only-01-reviewer-products-card"); await ctx.close();
});

test("[일반 회원] 심사 상품·카드 결제수단 미노출 — 일반 회원 카드결제 OFF 유지", async ({ browser }) => {
  setGate("reviewer"); const { ctx, page } = await openAs(browser, "A", "close");
  await gotoCheckout(page, reviewProduct("1회")); await expect(page.getByText("상품 정보를 찾을 수 없어요")).toBeVisible();
  expect(orderRows("A")).toBe(""); await shot(page, "auth-only-02-member-hidden"); await ctx.close();
});

test("[결제창 파라미터] goPay form — MID=nicepay00m·주문번호·금액=DB 가격·CARD·ReturnURL·euc-kr, 비밀 필드 없음, 열고 닫으면 주문 정리·승인 0", async ({ browser }) => {
  setGate("reviewer"); control({}); const { ctx, page } = await openAs(browser, "B", "close"); const m0 = membershipsOf(reviewProduct("1회")); const n0 = moneyCalls();
  const id = reviewProduct("1회"); await gotoCheckout(page, id); await pay(page).click();
  await expect.poll(() => formsOf(page).length, { timeout: 20_000 }).toBeGreaterThan(0);
  const f = formsOf(page)[0] as { MID: string; Moid: string; Amt: string; PayMethod: string; ReturnURL: string; acceptCharset: string; names: string[] };
  expect(f.MID).toBe("nicepay00m"); expect(f.Amt).toBe(String(productPrice(id))); expect(f.PayMethod).toBe("CARD"); expect(f.acceptCharset).toBe("euc-kr");
  expect(f.ReturnURL).toMatch(/^http:\/\/localhost:3100\/api\/payments\/nicepay\/return\?rt=/); expect(f.Moid).toMatch(/^[0-9a-f-]{36}$/);
  expect(f.names.filter((n) => /merchant|secret|key|token/i.test(n))).toEqual([]);
  await expect.poll(() => lastOrder()?.status, { timeout: 20_000 }).toBe("cancelled");   // 결제창 닫기 → 대기 주문 정리
  expect(membershipsOf(id)).toBe(m0); expect(moneyCalls()).toBe(n0); await shot(page, "auth-only-03-window-opened-closed");
  const body = await page.content(); expect(body).not.toContain(need("NICEPAY_MERCHANT_KEY")); await ctx.close();
});

test("[인증 완료(모의)] 인증 결과가 서버로 돌아와도 승인 API 0건·망취소 0건·수강권 0·주문 정리 — 결과 화면은 QA 안내(완료 아님)", async ({ browser }) => {
  setGate("reviewer"); control({}); const { ctx, page, external } = await openAs(browser, "B", "success"); const id = reviewProduct("1회"); const m0 = membershipsOf(id); const n0 = moneyCalls();
  await gotoCheckout(page, id); await pay(page).click(); await page.waitForURL(/\/checkout\/nicepay\/result/, { timeout: 30_000 });
  await expect(page.getByTestId("qa-auth-only-notice")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("결제가 완료됐어요.")).toHaveCount(0);
  expect(moneyCalls() - n0).toBe(0); expect(membershipsOf(id)).toBe(m0); await expect.poll(() => lastOrder()?.status, { timeout: 15_000 }).toBe("cancelled");
  expect(external, `외부 요청 0: ${JSON.stringify(external)}`).toEqual([]); await shot(page, "auth-only-04-auth-complete-no-approval"); await ctx.close();
});

for (const [mode, label] of [["badsig", "인증결과 서명 위변조"], ["amtmismatch", "금액 불일치(잘못된 금액)"], ["authfail", "인증 실패"], ["evilurl", "허용되지 않은 승인 URL"]] as const) {
  test(`[차단] ${label} — 승인 API 0건, 수강권 0, 결제 미완료`, async ({ browser }) => {
    setGate("reviewer"); control({}); const { ctx, page } = await openAs(browser, "B", mode); const id = reviewProduct("1회"); const m0 = membershipsOf(id); const n0 = moneyCalls();
    await gotoCheckout(page, id); await pay(page).click(); await page.waitForURL(/\/checkout\/nicepay\/result/, { timeout: 30_000 });
    await expect(page.getByText("결제가 완료됐어요.")).toHaveCount(0); await page.waitForTimeout(1500);
    expect(moneyCalls() - n0).toBe(0); expect(membershipsOf(id)).toBe(m0); await ctx.close();
  });
}

test("[잘못된 주문번호·금액] 서버 파라미터의 주문번호·금액이 화면 주문과 다르면 결제창을 열지 않는다(브라우저 검증기) — 승인 0", async ({ browser }) => {
  setGate("reviewer"); control({}); const { ctx, page } = await openAs(browser, "B", "close"); const id = reviewProduct("1회"); const n0 = moneyCalls();
  await page.route("**/api/payments/nicepay/prepare", async (route) => { const res = await route.fetch(); const j = await res.json(); if (j?.params) { j.params.Amt = String(Number(j.params.Amt) + 1000); } await route.fulfill({ response: res, json: j }); });
  await gotoCheckout(page, id); await pay(page).click(); await page.waitForTimeout(2500);
  expect(formsOf(page).length).toBe(0);   // 금액 불일치 → goPay 호출 없음
  await expect(page.getByText(/금액이 주문과 일치하지 않아요/).first()).toBeVisible({ timeout: 10_000 });
  expect(moneyCalls()).toBe(n0); await shot(page, "auth-only-05-tampered-amount-blocked"); await ctx.close();
});

test("[종합] 이 실행 전체에서 승인·망취소·외부 NICEPAY 호출 0건", async () => {
  expect(callCount("APPROVE")).toBe(0); expect(callCount("NETCANCEL")).toBe(0); expect(callCount("BLOCKED_EXTERNAL")).toBe(0);
});
