import { test, expect, openAs, gotoCheckout, setGate, orderRows, reviewProduct, opProduct, opCenter, callCount, shot, psql } from "./helpers";

/* 결제 비활성 검증 — NPQA_CONSTANT_OFF=1 로 실행(코드 상수 NICEPAY_CHECKOUT_ACTIVATED=false 그대로). 환경변수(provider=nicepay, ENABLED=true, v3 설정 모두)와 DB 게이트(reviewer/public)를 켜도 결제창이 열리지 않아야 한다. */
test.skip(!process.env.NPQA_CONSTANT_OFF, "NPQA_CONSTANT_OFF=1 전용");
test.describe.configure({ mode: "serial" });
test.afterAll(() => { setGate("off"); });

for (const mode of ["off", "reviewer", "public"] as const) {
  test(`[코드 상수 false · 게이트 ${mode}] NICEPAY 심사관 B — 환경변수가 모두 켜져 있어도 결제창·주문·승인 없음`, async ({ browser }) => {
    setGate(mode); const { ctx, page, external } = await openAs(browser, "B");
    const before = orderRows("B"); await gotoCheckout(page, reviewProduct("1회"));
    await page.locator(".checkout-pay-btn").first().click();
    await expect(page.getByText(/준비 중이에요|사용할 수 없/).first()).toBeVisible({ timeout: 15_000 });
    expect(await page.evaluate(() => (window as unknown as { __QA_GOPAY?: number }).__QA_GOPAY ?? 0)).toBe(0);
    expect(orderRows("B")).toBe(before); expect(callCount("APPROVE")).toBe(0); expect(external).toEqual([]);
    await shot(page, `20-constant-off-gate-${mode}`); await ctx.close();
  });
}
test("[코드 상수 false · 게이트 public] 일반 회원 A — 카드 미노출(직접결제만), NICEPAY 주문 없음, 직접결제는 정상 주문", async ({ browser }) => {
  setGate("public"); const { ctx, page } = await openAs(browser, "A");
  await gotoCheckout(page, opProduct(), opCenter());
  expect(await page.locator(".pay-method", { hasText: /카드|카카오페이|토스페이|계좌이체/ }).count()).toBe(0);
  const n0 = psql("select count(*) from orders where payment_provider is distinct from 'nicepay'");
  await page.locator(".checkout-pay-btn").first().click();
  await expect.poll(() => psql("select count(*) from orders where payment_provider is distinct from 'nicepay'"), { timeout: 20_000 }).not.toBe(n0);
  expect(orderRows("A")).toBe(""); await ctx.close();
});
