import { test, expect, openAs, setGate, control, calls, shot, reviewProduct, orderRows, membershipsOf, cleanNicepayOrders, formsOf, gotoCheckout, psql, BASE } from "./helpers";
import type { Page } from "@playwright/test";

/* NICEPAY 인증 전용(auth-only) + 앱(WebView) 복귀 설정 켜짐 — 앱 안(Capacitor 모의)에서도 승인 API 0건, 주문 정리, 완료 오표시 없음. 모의 결제창 결과(실제 NICEPAY·실기기 아님).
   실행: NPQA_AUTH_ONLY=1 NPQA_APP_RETURN=1 scripts/isolated/nicepayQa/run.sh tests/nicepay-qa/authOnlyApp.spec.ts */
test.describe.configure({ mode: "serial" });
const ON = process.env.NPQA_AUTH_ONLY === "1" && process.env.NPQA_APP_RETURN === "1";
test.skip(!ON, "NPQA_AUTH_ONLY=1 NPQA_APP_RETURN=1 로 실행해야 해요");
const SCHEME = "mwhabitnicepay";
const asCapacitor = (page: Page, platform: "ios" | "android") => page.addInitScript((pf) => { (window as unknown as { CapacitorCustomPlatform: unknown }).CapacitorCustomPlatform = { name: pf }; }, platform);
const moneyCalls = () => calls().filter((c) => ["APPROVE", "NETCANCEL", "BLOCKED_EXTERNAL"].includes(String(c.kind))).length;
const lastOrder = () => { const rows = orderRows("B").split(",").filter(Boolean); const r = rows[rows.length - 1]; return r ? { id: r.split(":")[0], status: r.split(":")[1] } : null; };
const pay = (p: Page) => p.locator(".checkout-pay-btn").first();
let P1 = "";
test.beforeAll(() => { P1 = reviewProduct("1회"); setGate("off"); cleanNicepayOrders(); control({}); });
test.afterAll(() => { setGate("off"); cleanNicepayOrders(); });

for (const platform of ["ios", "android"] as const) {
  test(`[앱 ${platform} · auth-only] WapUrl/IspCancelUrl(서버 scheme + 주문 UUID) 이 실리고, 인증이 끝나도 승인 0건·주문 cancelled·완료 화면 없음`, async ({ browser }) => {
    setGate("reviewer"); control({}); const { ctx, page, external } = await openAs(browser, "B", "success"); await asCapacitor(page, platform); const m0 = membershipsOf(P1); const n0 = moneyCalls();
    await gotoCheckout(page, P1); await pay(page).click(); await page.waitForURL(/\/checkout\/nicepay\/result/, { timeout: 30_000 });
    await expect(page.getByTestId("qa-auth-only-notice")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("결제가 완료됐어요.")).toHaveCount(0);
    const f = formsOf(page)[0] as { names: string[]; MID: string; Moid: string; WapUrl?: string; IspCancelUrl?: string };
    expect(f.MID).toBe("nicepay00m"); expect(f.names).toContain("WapUrl"); expect(f.names).toContain("IspCancelUrl");
    expect(f.names.filter((n) => /merchant|secret|key|token/i.test(n))).toEqual([]);
    if (f.WapUrl) expect(f.WapUrl.startsWith(`${SCHEME}://`)).toBe(true);
    expect(moneyCalls() - n0).toBe(0); expect(membershipsOf(P1)).toBe(m0); await expect.poll(() => lastOrder()?.status, { timeout: 15_000 }).toBe("cancelled");
    expect(external).toEqual([]); await shot(page, `auth-only-app-${platform}-no-approval`); await ctx.close();
  });
}

test("[앱 · 결제창 닫기] 앱에서 창을 닫으면 대기 주문 정리·승인 0", async ({ browser }) => {
  setGate("reviewer"); control({}); const { ctx, page } = await openAs(browser, "B", "close"); await asCapacitor(page, "ios"); const n0 = moneyCalls();
  await gotoCheckout(page, P1); await pay(page).click();
  await expect.poll(() => lastOrder()?.status, { timeout: 20_000 }).toBe("cancelled"); expect(moneyCalls() - n0).toBe(0); await ctx.close();
});

test("[앱 · 인증 실패/카드사 앱 취소(IspCancel) 복귀] 본인 pending 주문만 취소, 완료 표시 없음, 승인 0", async ({ browser }) => {
  setGate("reviewer"); control({}); cleanNicepayOrders(); const n0 = moneyCalls();
  const b = await openAs(browser, "B", "success"); await asCapacitor(b.page, "android");
  const bid = psql(`insert into orders(center_id, profile_id, product_id, product_name, amount, pay_method, status, payment_provider) select c.id, (select p.id from profiles p join accounts a on a.id=p.account_id where a.auth_id=(select id from auth.users where email='${process.env.TEST_USER_B_EMAIL}') limit 1), p.id, 'QA 앱복귀', p.price, 'card', 'pending', 'nicepay' from products p join centers c on c.id=p.center_id where p.id='${P1}' returning id`).split("\n")[0];
  await b.page.goto(`${BASE}/checkout/nicepay/result?orderId=${bid}&app=1&cancel=1`); await b.page.waitForLoadState("networkidle"); await b.page.waitForTimeout(1500);
  await expect(b.page.getByText("결제가 완료됐어요.")).toHaveCount(0);
  expect(psql(`select status from orders where id='${bid}'`)).toBe("cancelled"); expect(moneyCalls() - n0).toBe(0);
  psql(`delete from orders where id='${bid}'`); await b.ctx.close();
});

test("[종합] 앱 모드 auth-only 전체에서 승인·망취소·외부 호출 0건", () => { expect(moneyCalls()).toBe(0); });
