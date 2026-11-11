/* 뒤로가기 무한 반복 재현/검증 — 격리 브라우저(Playwright). 사용: ISO_ENV_FILE=<env> OUT=<dir> node tests/qa/backLoop/repro.mjs */
import { ctxFor, BASE, UX, browser, settle } from "../uxIntegration/lib.mjs";
const { page: p } = await ctxFor();
const path = () => { const u = new URL(p.url()); return u.pathname + (u.search ? "?…" : ""); };
const hlen = () => p.evaluate(() => history.length);
const label = (s) => s.replace(UX, "<UX>").replace(/product=[0-9a-f-]{36}/, "product=<P>");
const backBtn = () => p.locator(".back-header a.side, .back-header button.side, .app-back-btn").first();
const sheetOpen = () => p.evaluate(() => !!document.querySelector("[data-sheet-overlay]"));
async function toCheckoutFromHome() {
  await p.goto(`${BASE}/`, { waitUntil: "domcontentloaded" }); await settle(p, 2500);
  await p.getByRole("link", { name: "판매 상품" }).first().click(); await settle(p, 2500);
  await p.locator(`a[href*='/center/${UX}']`).first().click(); await settle(p, 3000);   // 센터(시트 자동 열림 ?buy=1)
  const row = p.locator("[data-sheet-overlay] button:has-text('구매')").first(); await row.click(); await p.waitForURL(/\/checkout\?/, { timeout: 15000 }); await settle(p, 3000);
}
const trail = [];
await toCheckoutFromHome(); trail.push("결제: " + label(path()) + `  [history.length=${await hlen()}]`);
for (let i = 1; i <= 5; i++) {
  if (await sheetOpen()) { await p.evaluate(() => window.__mwhabitBack?.()); await settle(p, 800); trail.push("(시트 닫기) " + label(path())); }
  if (!(await backBtn().count())) { trail.push(`(‹ 없음 — root: ${label(path())})`); break; }
  await backBtn().click(); await settle(p, 2500); trail.push(`‹ ${i}: ` + label(path()) + `  [history.length=${await hlen()}]`);
}
console.log(trail.join("\n"));
await browser.close();
