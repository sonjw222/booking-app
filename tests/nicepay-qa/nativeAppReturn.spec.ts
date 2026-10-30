import fs from "node:fs";
import { test, expect, openAs, setGate, control, callCount, shot, reviewProduct, orderRows, membershipsOf, cleanNicepayOrders, formsOf, gotoCheckout, psql, need, BASE } from "./helpers";
import type { Page } from "@playwright/test";

/* NICEPAY v3 앱(WebView) 결제 복귀(#255) — 격리 스택 + 모의 SDK·모의 승인 서버. 실제 NICEPAY 호출 0건, 네이티브(iOS/Android) 코드는 여기서 실행되지 않는다(네이티브 로직은 Swift/JUnit 단위 검증, 실기기는 BLOCKED).
   이 시험은 "앱 안(Capacitor)에서 서버가 WapUrl/IspCancelUrl 을 내려 주는가 / 웹에서는 아닌가 / 복귀 후 결과 화면이 서버 상태만 믿는가 / 위조·중복이 안전한가"를 본다.
   서버 앱 복귀 설정이 켜진 상태(NPQA_APP_RETURN=1)와 꺼진 상태 모두 필요 → 설정 의존 시험은 서버 환경을 보고 스스로 건너뛴다. */
test.describe.configure({ mode: "serial" });
const APP_ON = process.env.NPQA_APP_RETURN === "1";
let P1 = "";
test.beforeAll(() => { P1 = reviewProduct("1회"); setGate("off"); cleanNicepayOrders(); control({}); });
// 이 파일은 알파벳 순서상 nicepayV3.spec.ts 보다 먼저 실행된다 — 그 파일은 "호출 0건·주문 없음"을 절대값으로 단언하므로, 끝나면 이 시험이 만든 주문·모의 서버 호출 기록을 모두 비운다(시험 간 간섭 방지).
test.afterAll(() => { setGate("off"); control({}); cleanNicepayOrders(); try { fs.writeFileSync(need("NICEPAY_QA_LOG"), ""); } catch { /* 로그 없음 */ } });

const SCHEME = "mwhabitnicepay";
// Capacitor 공식 훅(CapacitorCustomPlatform)으로 앱 WebView 를 흉내 낸다 — getPlatform()/isNativePlatform() 이 진짜 @capacitor/core 코드로 계산된다(네이티브 브리지는 없음).
const asCapacitor = (page: Page, platform: "ios" | "android") => page.addInitScript((pf) => { (window as unknown as { CapacitorCustomPlatform: unknown }).CapacitorCustomPlatform = { name: pf }; }, platform);
const lastOrder = (who: "A" | "B" | "T") => { const rows = orderRows(who).split(",").filter(Boolean); const r = rows[rows.length - 1]; return r ? { id: r.split(":")[0], status: r.split(":")[1] } : null; };
const resultUrl = /\/checkout\/nicepay\/result/;
const pay = (p: Page) => p.locator(".checkout-pay-btn").first();

test("[웹 브라우저] 앱 복귀 설정 켜짐/꺼짐 모두 — 일반 모바일·PC 브라우저의 결제창 form 에는 WapUrl/IspCancelUrl 이 없다(기존 흐름 유지)", async ({ browser }) => {
  setGate("reviewer"); control({}); const { ctx, page } = await openAs(browser, "B", "success"); const m0 = membershipsOf(P1);
  await gotoCheckout(page, P1); await pay(page).click(); await page.waitForURL(resultUrl, { timeout: 30_000 });
  await expect(page.getByText("결제가 완료됐어요.")).toBeVisible({ timeout: 30_000 });
  const f = formsOf(page)[0] as { names: string[] }; expect(f.names).not.toContain("WapUrl"); expect(f.names).not.toContain("IspCancelUrl"); expect(f.names).toContain("ReturnURL");
  expect(membershipsOf(P1)).toBe(m0 + 1); await ctx.close();
});

for (const platform of ["ios", "android"] as const) {
  test(`[앱 ${platform}] ${APP_ON ? "서버 설정 켜짐: WapUrl/IspCancelUrl 이 form 에 실리고(서버 scheme + 주문 UUID), 결제는 서버 승인 후에만 완료" : "서버 설정 꺼짐(기본·운영과 같은 상태): 앱이어도 WapUrl/IspCancelUrl 이 없다"}`, async ({ browser }) => {
    setGate("reviewer"); control({}); const { ctx, page } = await openAs(browser, "B", "success"); await asCapacitor(page, platform);
    const m0 = membershipsOf(P1), a0 = callCount("APPROVE");
    await gotoCheckout(page, P1); await pay(page).click(); await page.waitForURL(resultUrl, { timeout: 30_000 });
    await expect(page.getByText("결제가 완료됐어요.")).toBeVisible({ timeout: 30_000 });
    const f = formsOf(page)[0] as { names: string[]; ReturnURL: string; Moid: string };
    expect(f.ReturnURL).toMatch(/^http:\/\/localhost:3100\/api\/payments\/nicepay\/return\?rt=/);   // ReturnURL 은 HTTPS(sandbox 한정 localhost) 서버 경로 그대로
    if (APP_ON) { expect(f.names).toContain("WapUrl"); expect(f.names).toContain("IspCancelUrl"); } else { expect(f.names).not.toContain("WapUrl"); expect(f.names).not.toContain("IspCancelUrl"); }
    expect(f.names.filter((n) => /merchant|secret|key|token/i.test(n))).toEqual([]);
    expect(callCount("APPROVE") - a0).toBe(1); expect(membershipsOf(P1)).toBe(m0 + 1);
    await shot(page, `app-${platform}-result-done-${APP_ON ? "on" : "off"}`); await ctx.close();
  });
}

test("[앱 복귀 화면] 로그인 세션만으로 서버 상태를 묻는다 — 서버가 done 일 때만 완료, 승인 전(pending)·타인 주문·세션 없음·위조 id 는 완료로 보이지 않는다", async ({ browser }) => {
  setGate("reviewer"); control({}); cleanNicepayOrders();
  // (a) pending 주문(결제창 닫기 전 상태를 만든다: 결제 화면에서 주문만 생성 후 SDK 닫힘)
  const b = await openAs(browser, "B", "close"); await asCapacitor(b.page, "ios");
  await gotoCheckout(b.page, P1); await pay(b.page).click(); await b.page.waitForTimeout(2500);
  const pending = lastOrder("B"); // close 모드에서는 결제창을 닫아 주문이 취소될 수 있다 → 아래에서 직접 pending 을 만든다
  // 직접 만든 pending 주문(승인 흔적 없음)
  const pid = psql(`select id from orders where profile_id in (select p.id from profiles p join accounts a on a.id=p.account_id where a.auth_id=(select id from auth.users where email='${process.env.TEST_USER_B_EMAIL}')) and status='pending' order by created_at desc limit 1`);
  const target = pid || pending?.id || "";
  await b.page.goto(`${BASE}/checkout/nicepay/result?orderId=${target}&app=1`); await b.page.waitForLoadState("networkidle");
  await expect(b.page.getByText("결제가 완료됐어요.")).toHaveCount(0);   // 복귀 URL 에 도착했다는 사실은 성공이 아니다
  await shot(b.page, "app-return-pending-not-done");
  // (b) 존재하지 않는 UUID·형식 불량 id
  for (const bad of ["00000000-0000-4000-8000-000000000000", "not-a-uuid", "' or 1=1 --"]) {
    await b.page.goto(`${BASE}/checkout/nicepay/result?orderId=${encodeURIComponent(bad)}&app=1`); await b.page.waitForLoadState("networkidle"); await b.page.waitForTimeout(800);
    await expect(b.page.getByText("결제가 완료됐어요.")).toHaveCount(0);
  }
  // (c) 다른 사용자(A)의 세션으로 B 의 주문 id 를 열어도 완료로 보이지 않는다
  const a = await openAs(browser, "A", "success");
  await a.page.goto(`${BASE}/checkout/nicepay/result?orderId=${target}&app=1`); await a.page.waitForLoadState("networkidle"); await a.page.waitForTimeout(800);
  await expect(a.page.getByText("결제가 완료됐어요.")).toHaveCount(0);
  // (d) 세션 없음
  const anon = await browser.newContext(); const ap = await anon.newPage();
  await ap.goto(`${BASE}/checkout/nicepay/result?orderId=${target}&app=1`); await ap.waitForLoadState("networkidle"); await ap.waitForTimeout(800);
  await expect(ap.getByText("결제가 완료됐어요.")).toHaveCount(0); await expect(ap.getByText(/로그인이 필요해요/)).toBeVisible();
  await shot(ap, "app-return-no-session");
  await b.ctx.close(); await a.ctx.close(); await anon.close();
});

test("[앱 복귀 — 완료된 주문] 서버가 done 이면 완료 안내, 같은 복귀를 두 번 열어도(중복 복귀) 수강권·주문은 그대로", async ({ browser }) => {
  setGate("reviewer"); control({}); cleanNicepayOrders();
  const { ctx, page } = await openAs(browser, "B", "success"); await asCapacitor(page, "android");
  await gotoCheckout(page, P1); await pay(page).click(); await page.waitForURL(resultUrl, { timeout: 30_000 }); await expect(page.getByText("결제가 완료됐어요.")).toBeVisible({ timeout: 30_000 });
  const o = lastOrder("B")!; const m = membershipsOf(P1), a = callCount("APPROVE");
  for (let i = 0; i < 2; i++) { await page.goto(`${BASE}/checkout/nicepay/result?orderId=${o.id}&app=1`); await page.waitForLoadState("networkidle"); await expect(page.getByText("결제가 완료됐어요.")).toBeVisible({ timeout: 20_000 }); }
  expect(membershipsOf(P1)).toBe(m); expect(callCount("APPROVE")).toBe(a); expect(lastOrder("B")!.status).toBe("done");
  // 완료된 주문에 취소 복귀(cancel=1)가 와도 되돌려지지 않는다(서버가 pending 만 취소)
  await page.goto(`${BASE}/checkout/nicepay/result?orderId=${o.id}&app=1&cancel=1`); await page.waitForLoadState("networkidle"); await page.waitForTimeout(1000);
  expect(lastOrder("B")!.status).toBe("done"); expect(membershipsOf(P1)).toBe(m);
  await shot(page, "app-return-duplicate-and-cancel-on-done"); await ctx.close();
});

test("[ISP 취소 복귀] cancel=1 — 본인 pending 주문만 취소되고 '완료'는 보이지 않는다. 타인 주문은 취소되지 않는다", async ({ browser }) => {
  setGate("reviewer"); control({}); cleanNicepayOrders();
  const b = await openAs(browser, "B", "success"); await asCapacitor(b.page, "ios");
  // 승인 흔적이 없는 본인(B)·타인(A) pending 주문을 격리 DB 에 직접 만든다(결제창을 열지 않고 상태만 준비).
  const bid = psql(`insert into orders(center_id, profile_id, product_id, product_name, amount, pay_method, status, payment_provider) select c.id, (select p.id from profiles p join accounts a on a.id=p.account_id where a.auth_id=(select id from auth.users where email='${process.env.TEST_USER_B_EMAIL}') limit 1), p.id, 'QA 앱복귀', p.price, 'card', 'pending', 'nicepay' from products p join centers c on c.id=p.center_id where p.id='${P1}' returning id`).split("\n")[0];
  const aid = psql(`insert into orders(center_id, profile_id, product_id, product_name, amount, pay_method, status, payment_provider) select c.id, (select p.id from profiles p join accounts a on a.id=p.account_id where a.auth_id=(select id from auth.users where email='${process.env.TEST_USER_A_EMAIL}') limit 1), p.id, 'QA 타인', p.price, 'card', 'pending', 'nicepay' from products p join centers c on c.id=p.center_id where p.id='${P1}' returning id`).split("\n")[0];
  const st = (id: string) => psql(`select status from orders where id='${id}'`);
  await b.page.goto(`${BASE}/checkout/nicepay/result?orderId=${bid}&app=1&cancel=1`); await b.page.waitForLoadState("networkidle"); await b.page.waitForTimeout(1500);
  await expect(b.page.getByText("결제가 완료됐어요.")).toHaveCount(0);
  expect(st(bid)).toBe("cancelled"); await shot(b.page, "app-return-isp-cancel");
  await b.page.goto(`${BASE}/checkout/nicepay/result?orderId=${aid}&app=1&cancel=1`); await b.page.waitForLoadState("networkidle"); await b.page.waitForTimeout(1500);
  expect(st(aid)).toBe("pending");   // 로그인한 B 가 A 의 주문을 취소할 수 없다(서버가 소유 확인)
  psql(`delete from orders where id in ('${bid}','${aid}')`);
  await b.ctx.close();
});

test("[인증 성공 후 서버 승인 실패 — 앱] 승인 거절·무응답이어도 결제 미완료 유지(수강권 0), 주문은 pending 복귀", async ({ browser }) => {
  for (const approve of ["reject", "timeout"]) {
    setGate("reviewer"); control({ approve }); cleanNicepayOrders();
    const { ctx, page } = await openAs(browser, "B", "success"); await asCapacitor(page, "ios"); const m0 = membershipsOf(P1);
    await gotoCheckout(page, P1); await pay(page).click(); await page.waitForURL(resultUrl, { timeout: 30_000 });
    await expect(page.getByText("결제가 완료되지 않았어요.").first()).toBeVisible({ timeout: 20_000 });
    expect(membershipsOf(P1)).toBe(m0); await expect.poll(() => lastOrder("B")?.status, { timeout: 15_000 }).toBe("pending");
    // 이 주문의 앱 복귀(wap)를 열어도 완료로 보이지 않는다
    await page.goto(`${BASE}/checkout/nicepay/result?orderId=${lastOrder("B")!.id}&app=1`); await page.waitForLoadState("networkidle"); await page.waitForTimeout(800);
    await expect(page.getByText("결제가 완료됐어요.")).toHaveCount(0);
    control({}); await ctx.close();
  }
});

test("[일반 회원·결제 OFF] 게이트 off 에서는 앱이어도 결제창·승인 호출 없음", async ({ browser }) => {
  setGate("off"); control({}); const { ctx, page } = await openAs(browser, "B", "success"); await asCapacitor(page, "ios"); const a0 = callCount("APPROVE");
  await gotoCheckout(page, P1); await page.waitForTimeout(1500);
  expect(callCount("APPROVE") - a0).toBe(0); expect(formsOf(page).length).toBe(0); await ctx.close();
});
