import { test, expect, openAs, formsOf, gotoCheckout, setGate, setMode, control, callCount, calls, shot, reviewProduct, productPrice, opCenter, opProduct, orderRows, membershipsOf, cleanNicepayOrders, psql, BASE, need } from "./helpers";
import type { BrowserContext, Page } from "@playwright/test";

/* NICEPAY v3 결제창 — 격리 스택 실브라우저(Chromium). 결제창 SDK 는 모의(goPay), 승인/망취소는 서버 fetch 가로채기 모의. 실제 NICEPAY 호출 0건.
   전제 상태: 게이트 off(기본). 시험이 끝나면 게이트를 off 로 되돌린다. */
test.describe.configure({ mode: "serial" });
let P1 = ""; let price = 0;
test.beforeAll(() => { P1 = reviewProduct("1회"); price = productPrice(P1); setGate("off"); cleanNicepayOrders(); control({}); });
test.afterAll(() => { setGate("off"); });

const payBtn = (p: Page) => p.locator(".checkout-pay-btn").first();
const resultUrl = /\/checkout\/nicepay\/result/;

test("[게이트 off] NICEPAY 심사관 B — 결제창·SDK 호출 없음, 주문 미생성(심사관도 거부)", async ({ browser }) => {
  setGate("off"); const { ctx, page, external } = await openAs(browser, "B");
  await gotoCheckout(page, P1);
  await shot(page, "01-gate-off-checkout");
  await payBtn(page).click();
  await expect(page.getByText(/준비 중|사용할 수 없|결제.*실패|오류/).first()).toBeVisible({ timeout: 15_000 });
  expect(await page.evaluate(() => (window as unknown as { __QA_GOPAY?: number }).__QA_GOPAY ?? 0)).toBe(0);
  expect(orderRows("B")).toBe(""); expect(external).toEqual([]); expect(callCount("APPROVE")).toBe(0);
  await ctx.close();
});

test("[게이트 reviewer] 일반 회원 A·토스 심사관 T — 심사 센터 상품은 보이지 않고, 운영 센터 결제수단에 카드 미노출(직접결제만), NICEPAY 주문 없음", async ({ browser }) => {
  setGate("reviewer");
  for (const who of ["A", "T"] as const) {
    const { ctx, page, external } = await openAs(browser, who);
    await gotoCheckout(page, P1);                                           // 심사 센터 상품 URL 을 알아도
    await expect(page.getByText("상품 정보를 찾을 수 없어요")).toBeVisible();
    await shot(page, `02-reviewer-gate-${who}-review-product-hidden`);
    await gotoCheckout(page, opProduct(), opCenter());                      // 운영 센터 상품(일반 회원의 기존 결제 화면)
    await shot(page, `02-reviewer-gate-${who}-operating-checkout`);
    expect(await page.locator(".pay-method", { hasText: /카드/ }).count(), `${who}: 카드 결제수단이 보이면 안 됨`).toBe(0);
    await expect(page.getByText(/직접 결제|센터에서 직접/).first()).toBeVisible();
    expect(external).toEqual([]); await ctx.close();
  }
  expect(orderRows("A") + orderRows("T")).toBe("");
});

test("[게이트 reviewer] 심사관 B — 심사 상품 결제 성공: 서버 승인 후에만 수강권 발급(1건), 외부 호출 0건", async ({ browser }) => {
  setGate("reviewer"); control({}); const { ctx, page, external } = await openAs(browser, "B", "success");
  const before = membershipsOf(P1);
  await gotoCheckout(page, P1);
  await expect(page.locator(".pay-method", { hasText: /카드/ }).first()).toBeVisible();
  await shot(page, "03-reviewer-checkout");
  await payBtn(page).click();
  await page.waitForURL(resultUrl, { timeout: 30_000 });
  await expect(page.getByText("결제가 완료됐어요.")).toBeVisible({ timeout: 30_000 });
  await shot(page, "04-reviewer-result-done");
  expect(callCount("APPROVE")).toBe(1); expect(callCount("NETCANCEL")).toBe(0);
  expect(membershipsOf(P1)).toBe(before + 1);
  expect(orderRows("B").split(",").filter((r) => r.includes(":done:nicepay")).length).toBe(1);
  expect(external, `외부(비로컬) 요청 0건: ${JSON.stringify(external)}`).toEqual([]);
  // 결과 URL 보관 — 모바일 WebView 복귀 시험에서 재사용
  (globalThis as unknown as { __RESULT_URL?: string }).__RESULT_URL = page.url();
  await ctx.close();
});

const lastOrder = (who: "A" | "B" | "T") => { const rows = orderRows(who).split(",").filter(Boolean); const r = rows[rows.length - 1]; return r ? { id: r.split(":")[0], status: r.split(":")[1] } : null; };
async function payAndSettle(page: Page, expectDone: boolean) {
  await payBtn(page).click();
  if (expectDone) { await page.waitForURL(resultUrl, { timeout: 30_000 }); await expect(page.getByText("결제가 완료됐어요.")).toBeVisible({ timeout: 30_000 }); }
  else await page.waitForURL(resultUrl, { timeout: 30_000 });
}

test("[v3 결제창 파라미터] goPay 호출 form — MID·금액·주문번호·CARD·ReturnURL(rt)·euc-kr, 비밀값 필드 없음", async ({ browser }) => {
  setGate("reviewer"); control({}); const { ctx, page } = await openAs(browser, "B", "success");
  await gotoCheckout(page, P1); await payBtn(page).click(); await page.waitForURL(resultUrl, { timeout: 30_000 });
  const f = formsOf(page)[0] as { MID: string; Moid: string; Amt: string; PayMethod: string; ReturnURL: string; acceptCharset: string; names: string[] };
  expect(f.MID).toBe(need("NICEPAY_MID")); expect(f.Amt).toBe(String(price)); expect(f.PayMethod).toBe("CARD");
  expect(f.Moid).toMatch(/^[0-9a-f-]{36}$/); expect(f.ReturnURL.startsWith(`${BASE}/api/payments/nicepay/return?rt=`)).toBe(true); expect(f.acceptCharset.toLowerCase()).toBe("euc-kr");
  expect(f.names.filter((n) => /merchant|secret|private|key/i.test(n))).toEqual([]);   // 서버 MerchantKey 가 브라우저 form 에 없다
  expect(f.names).toEqual(expect.arrayContaining(["MID", "Moid", "Amt", "GoodsName", "EdiDate", "SignData", "ReturnURL", "PayMethod"]));
  await ctx.close();
});

test("[닫기/취소] 결제창을 인증 전에 닫으면 주문 취소(승인 호출 없음) → 같은 화면에서 재시도 성공", async ({ browser }) => {
  setGate("reviewer"); control({}); const { ctx, page } = await openAs(browser, "B", "close");
  const a0 = callCount("APPROVE"); const m0 = membershipsOf(P1);
  await gotoCheckout(page, P1); await payBtn(page).click();
  await expect.poll(() => lastOrder("B")?.status, { timeout: 20_000 }).toBe("cancelled");
  await shot(page, "05-closed-before-auth");
  expect(callCount("APPROVE")).toBe(a0); expect(membershipsOf(P1)).toBe(m0);
  await setMode(page, "success");
  await payAndSettle(page, true);
  expect(membershipsOf(P1)).toBe(m0 + 1); expect(callCount("APPROVE")).toBe(a0 + 1);
  await ctx.close();
});

for (const [mode, label] of [["authfail", "인증 실패(AuthResultCode≠0000)"], ["badsig", "인증결과 서명 위변조"], ["amtmismatch", "인증결과 금액 불일치(서명은 변조 금액 기준)"], ["evilurl", "인증결과 NextAppURL 이 허용되지 않은 외부 호스트"]] as const) {
  test(`[실패] ${label} — 승인 API 호출 없음, 수강권 미발급, 결과 화면은 실패 안내`, async ({ browser }) => {
    setGate("reviewer"); control({}); const { ctx, page } = await openAs(browser, "B", mode);
    const a0 = callCount("APPROVE"); const m0 = membershipsOf(P1);
    await gotoCheckout(page, P1); await payAndSettle(page, false);
    await expect(page.getByText("결제가 완료되지 않았어요.").first()).toBeVisible({ timeout: 20_000 });
    await shot(page, `06-${mode}`);
    expect(callCount("APPROVE")).toBe(a0); expect(membershipsOf(P1)).toBe(m0);
    await ctx.close();
  });
}

for (const [approve, label, expectNet] of [["reject", "승인 거절(3011)", false], ["badsig", "승인 응답 서명 불일치", true], ["wrongamt", "승인 응답 금액 불일치", true], ["wrongmoid", "승인 응답 주문번호 불일치", true], ["timeout", "승인 응답 없음(네트워크 오류)", true], ["http500", "승인 5xx", true]] as const) {
  test(`[인증 성공 후 승인 실패] ${label} — ${expectNet ? "망취소 호출·" : ""}수강권 미발급·주문 재시도 가능(pending 복귀)`, async ({ browser }) => {
    setGate("reviewer"); control({ approve }); const { ctx, page } = await openAs(browser, "B", "success");
    const n0 = callCount("NETCANCEL"); const m0 = membershipsOf(P1);
    await gotoCheckout(page, P1); await payAndSettle(page, false);
    await expect(page.getByText("결제가 완료되지 않았어요.").first()).toBeVisible({ timeout: 20_000 });
    await shot(page, `07-approve-${approve}`);
    expect(membershipsOf(P1)).toBe(m0);
    expect(callCount("NETCANCEL") - n0).toBe(expectNet ? 1 : 0);
    await expect.poll(() => lastOrder("B")?.status, { timeout: 15_000 }).toBe("pending");   // 승인되지 않았거나 망취소가 확인된 주문은 pending 으로 복귀(진행 중 approving 으로 남지 않음)
    control({}); await ctx.close();
  });
}

test("[중복·새로고침] 같은 인증 결과를 다시 POST 해도 승인 1회·수강권 1개, 결과 화면 새로고침은 같은 결과", async ({ browser }) => {
  setGate("reviewer"); control({}); const { ctx, page } = await openAs(browser, "B", "success");
  const posts: Array<{ url: string; body: string }> = []; let resultLocation = "";
  page.on("response", async (r) => { if (r.request().method() === "POST" && r.url().includes("/api/payments/nicepay/return")) resultLocation = r.headers()["location"] ?? resultLocation; });
  page.on("request", (r) => { if (r.method() === "POST" && r.url().includes("/api/payments/nicepay/return")) posts.push({ url: r.url(), body: r.postData() ?? "" }); });
  const a0 = callCount("APPROVE"); const m0 = membershipsOf(P1);
  await gotoCheckout(page, P1); await payAndSettle(page, true);
  expect(posts.length).toBe(1);
  for (let i = 0; i < 2; i++) { const r = await page.request.post(posts[0].url, { headers: { "content-type": "application/x-www-form-urlencoded" }, data: posts[0].body, maxRedirects: 0 }); expect([303]).toContain(r.status()); }
  // 결과 화면은 처리 직후 주소창의 토큰(rt)을 지운다 → 새로고침하면 "확인 정보가 만료" 안내(설계) — 재승인·중복 발급 없이 앱의 구매내역으로 안내한다
  await page.reload(); await expect(page.getByText("결제 확인 정보가 올바르지 않거나 만료됐어요.")).toBeVisible({ timeout: 20_000 }); await shot(page, "08-result-refresh-after-scrub");
  expect(callCount("APPROVE")).toBe(a0 + 1); expect(membershipsOf(P1)).toBe(m0 + 1);
  expect(resultLocation).toContain("/checkout/nicepay/result?orderId="); (globalThis as unknown as { __RESULT_URL?: string }).__RESULT_URL = resultLocation;
  // 모바일 WebView 복귀: 로그인 세션 없는 새 브라우저 컨텍스트에서도 서명된 복귀 토큰(rt)만으로 결과 화면이 DB 진실(완료)을 보여준다
  const wv = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 MwhabitWebView" });
  const w = await wv.newPage(); await w.goto((globalThis as unknown as { __RESULT_URL: string }).__RESULT_URL.replace(/^https?:\/\/[^/]+/, BASE));
  await expect(w.getByText("결제가 완료됐어요.")).toBeVisible({ timeout: 20_000 }); await shot(w, "08-mobile-webview-return");
  // 토큰 없이/다른 주문 토큰으로는 확인 불가
  const u = new URL((globalThis as unknown as { __RESULT_URL: string }).__RESULT_URL.replace(/^https?:\/\/[^/]+/, BASE)); u.searchParams.delete("rt");
  await w.goto(u.toString()); await expect(w.getByText("결제 확인 정보가 올바르지 않거나 만료됐어요.")).toBeVisible(); await expect(w.getByText("결제가 완료됐어요.")).toHaveCount(0);
  await wv.close(); await ctx.close();
});

test("[모바일 폭·WebView UA] 심사관 B — 모바일 환경에서도 결제창 호출→서버 승인→결과 화면 완료(수강권 1개), 가로 넘침 없음", async ({ browser }) => {
  setGate("reviewer"); control({});
  const ctx = await browser.newContext({ storageState: await (await import("./helpers")).sessionFor(browser, "B"), viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 MwhabitWebView" });
  const page = await ctx.newPage(); await (await import("./helpers")).installMockSdk(page, "success");
  const m0 = membershipsOf(P1); await gotoCheckout(page, P1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
  await shot(page, "08b-mobile-checkout"); await payAndSettle(page, true); await shot(page, "08b-mobile-result");
  expect(membershipsOf(P1)).toBe(m0 + 1); await ctx.close();
});

test("[동시 중복] 같은 인증 결과가 동시에 3번 도착해도 승인 1회·수강권 1개(원자적 선점)", async ({ browser }) => {
  setGate("reviewer"); control({}); const { ctx, page } = await openAs(browser, "B", "success");
  const a0 = callCount("APPROVE"); const m0 = membershipsOf(P1); let statuses: number[] = [];
  await page.route("**/api/payments/nicepay/return**", async (route) => {
    const req = route.request(); const opts = { headers: { "content-type": "application/x-www-form-urlencoded" }, data: req.postData() ?? "", maxRedirects: 0 as const };
    const rs = await Promise.all([page.request.post(req.url(), opts), page.request.post(req.url(), opts), page.request.post(req.url(), opts)]);
    statuses = rs.map((r) => r.status()); await route.abort();
  });
  await gotoCheckout(page, P1); await payBtn(page).click();
  await expect.poll(() => statuses.length, { timeout: 30_000 }).toBe(3);
  expect(statuses.every((s) => s === 303)).toBe(true);
  expect(callCount("APPROVE") - a0).toBe(1); expect(membershipsOf(P1)).toBe(m0 + 1);
  expect(lastOrder("B")?.status).toBe("done"); await ctx.close();
});

test("[위변조] 복귀 토큰 없음/다른 값으로 return 라우트 POST — 승인 호출 없이 invalid 로 되돌림", async ({ browser }) => {
  setGate("reviewer"); const { ctx, page } = await openAs(browser, "B", "success");
  const a0 = callCount("APPROVE");
  for (const url of [`${BASE}/api/payments/nicepay/return`, `${BASE}/api/payments/nicepay/return?rt=forged.token`]) {
    const r = await page.request.post(url, { form: { Moid: "00000000-0000-4000-8000-000000000000", AuthResultCode: "0000", AuthToken: "QATOK_x", Amt: "1000", MID: need("NICEPAY_MID"), Signature: "0".repeat(64) }, maxRedirects: 0 });
    expect(r.status()).toBe(303); expect(r.headers()["location"]).toContain("invalid=1");
  }
  expect(callCount("APPROVE")).toBe(a0);
  await ctx.close();
});

test("[SDK 로드 실패] 결제창 스크립트가 로드되지 않으면 오류 안내 + 생성된 대기 주문 정리, 승인 호출 없음", async ({ browser }) => {
  setGate("reviewer"); const { ctx, page } = await openAs(browser, "B", "success");
  await page.route("https://pg-web.nicepay.co.kr/**", (r) => r.abort());
  const a0 = callCount("APPROVE"); await gotoCheckout(page, P1); await payBtn(page).click();
  await expect(page.getByText(/불러오지 못했어요|오류|실패/).first()).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => lastOrder("B")?.status, { timeout: 15_000 }).toBe("cancelled");
  expect(callCount("APPROVE")).toBe(a0); await ctx.close();
});

test("[게이트 public] 일반 회원 A — NICEPAY 게이트가 public 이어도 PG_CHECKOUT_ENABLED 미설정이면 카드 미노출, 직접결제는 정상 주문 생성", async ({ browser }) => {
  setGate("public"); const { ctx, page } = await openAs(browser, "A");
  await gotoCheckout(page, opProduct(), opCenter());
  expect(await page.locator(".pay-method", { hasText: /카드|카카오페이|토스페이|계좌이체/ }).count()).toBe(0);
  await shot(page, "09-public-gate-member-direct-only");
  const before = psql("select count(*) from orders where payment_provider is distinct from 'nicepay'");
  await payBtn(page).click();
  await expect.poll(() => psql("select count(*) from orders where payment_provider is distinct from 'nicepay'"), { timeout: 20_000 }).not.toBe(before);   // 직접결제 주문 생성(PG·SDK 호출 없음)
  expect(orderRows("A")).toBe("");
  setGate("off"); await ctx.close();
});

test("[심사 대상 소속] NICEPAY 심사관 B — 운영 센터 상품은 보이지 않고(심사 센터만 접근), 주문·결제창 호출이 불가", async ({ browser }) => {
  setGate("reviewer"); const { ctx, page } = await openAs(browser, "B"); const o0 = orderRows("B");
  await gotoCheckout(page, opProduct(), opCenter());
  await expect(page.getByText("상품 정보를 찾을 수 없어요")).toBeVisible(); await shot(page, "09-reviewer-operating-product-hidden");
  expect(await page.evaluate(() => (window as unknown as { __QA_GOPAY?: number }).__QA_GOPAY ?? 0)).toBe(0); expect(orderRows("B")).toBe(o0);
  setGate("off"); await ctx.close();
});

test("[홈 푸터·상품 기간] 비로그인 홈 푸터에 사업자 정보(주소 포함)가 표시되고, 심사 상품에 사전예약·서비스 제공기간이 날짜로 표시된다", async ({ browser }) => {
  const { BUSINESS_INFO } = await import("../../lib/businessInfo");
  const ctx = await browser.newContext(); const page = await ctx.newPage();
  await page.goto(`${BASE}/`); await page.waitForLoadState("networkidle");
  const footer = (await page.locator(".home-footer").innerText()).replace(/\s+/g, " ");
  expect(footer.includes(BUSINESS_INFO.address), "홈 푸터에 사업자 주소가 표시된다(값은 출력하지 않음)").toBe(true);
  expect(footer.includes(BUSINESS_INFO.businessRegNo) && footer.includes(BUSINESS_INFO.companyName)).toBe(true);
  await ctx.close();
  const b = await openAs(browser, "B"); setGate("reviewer");
  for (const n of ["1회", "4주", "3개월"]) {
    await gotoCheckout(b.page, reviewProduct(n));
    await expect(b.page.getByText("사전예약기간").first()).toBeVisible(); await expect(b.page.getByText("서비스 제공기간").first()).toBeVisible(); await expect(b.page.getByTestId("service-period-prebooking")).toBeVisible();
    const sp = (await b.page.getByTestId("service-period-service").innerText()).replace(/\s+/g, " ");
    const m = /(\d{4})년 (\d{1,2})월 (\d{1,2})일 ~ (\d{4})년 (\d{1,2})월 (\d{1,2})일/.exec(sp); expect(m, `서비스 제공기간 날짜 표시(${n})`).not.toBeNull();
    const days = (Date.UTC(+m![4], +m![5] - 1, +m![6]) - Date.UTC(+m![1], +m![2] - 1, +m![3])) / 86400000;
    expect(days).toBeGreaterThan(0); expect(days).toBeLessThanOrEqual(365);   // NICEPAY 기준: 서비스 제공기간 1년 이내(사전예약 60일 이내 — 시드는 결제일=시작일)
    await shot(b.page, `10-service-period-${n}`);
  }
  setGate("off"); await b.ctx.close();
});
