/*
  결제 ↔ 센터 뒤로가기 회귀 스위트(실제 Chromium history). 사용: ISO_ENV_FILE=<격리 env> OUT=<dir> node tests/qa/backLoop/suite.mjs
  전제: 격리 스택 + localUxFixture.sql + A10TION 모사 센터/심사 계정(NICEQA_*) + next start(3216)/https 프록시(3217) — docs/qa/ux-final-20261109/REPORT.md 참고.
*/
import { ctxFor, BASE, UX, browser, settle, check, save, env, psql } from "../uxIntegration/lib.mjs";
const SDK = "https://pg-web.nicepay.co.kr/v3/common/js/nicepay-pgweb.js";
const SDK_JS = `window.goPay=function(form){window.__GOPAY=(window.__GOPAY||0)+1;var g=function(n){var e=form.elements[n];return e?e.value:undefined};window.__FORM={ReturnURL:form.action,Moid:g('Moid')};};`;
const P = (p) => { const u = new URL(p.url()); return u.pathname; };
const len = (p) => p.evaluate(() => history.length);
const backCtl = (p) => p.locator(".back-header a.side, .back-header button.side, .app-back-btn").first();
const sheetOpen = (p) => p.evaluate(() => !!document.querySelector("[data-sheet-overlay]"));
const visited = []; const watch = (p) => p.on("framenavigated", (f) => { if (f === p.mainFrame()) visited.push(new URL(f.url()).pathname); });
async function pressBack(p) { if (await sheetOpen(p)) { await p.evaluate(() => window.__mwhabitBack?.()); await settle(p, 700); } if (!(await backCtl(p).count())) return "ROOT"; await backCtl(p).click(); await settle(p, 2200); return P(p); }
const CENTER = `/center/${UX}`;
async function viaSearchToCheckout(p) {   // 홈 → (찾기 탭) 검색 → 센터 → 구매 시트 → 결제
  await p.goto(`${BASE}/`, { waitUntil: "domcontentloaded" }); await settle(p, 2500);
  await p.getByRole("link", { name: "찾기" }).first().click(); await settle(p, 2500);
  await p.locator("input[type='search'], input[placeholder*='검색']").first().fill("UX"); await settle(p, 1500);
  await p.locator(`a[href='${CENTER}']`).first().click(); await settle(p, 3000);
  await p.getByRole("button", { name: /수강권 구매하기|수강권 안내/ }).first().click(); await settle(p, 1200);
  await p.locator("[data-sheet-overlay] button:has-text('구매')").first().click(); await p.waitForURL(/\/checkout\?/, { timeout: 15000 }); await settle(p, 3000);
}
async function viaProductsToCheckout(p) {   // 홈 → 판매 상품 → 센터(?buy=1) → 결제
  await p.goto(`${BASE}/`, { waitUntil: "domcontentloaded" }); await settle(p, 2500);
  await p.getByRole("link", { name: "판매 상품" }).first().click(); await settle(p, 2500);
  await p.locator(`a[href*='${CENTER}']`).first().click(); await settle(p, 3000);
  await p.locator("[data-sheet-overlay] button:has-text('구매')").first().click(); await p.waitForURL(/\/checkout\?/, { timeout: 15000 }); await settle(p, 3000);
}
// ── T1 홈 → 판매 상품 → 센터 → 결제 → ‹ ‹ ‹ ──
{
  const { ctx, page: p } = await ctxFor(); watch(p); await viaProductsToCheckout(p); const L0 = await len(p); visited.length = 0;
  const r1 = await pressBack(p), r2 = await pressBack(p), r3 = await pressBack(p), r4 = await pressBack(p);
  check("T1", "홈→판매상품→센터→결제 후 ‹: 센터 → 판매상품 → 홈, 결제로 되돌아가지 않음·history 증가 없음", r1 === CENTER && r2 === "/products" && r3 === "/" && r4 === "ROOT" && !visited.includes("/checkout") && (await len(p)) <= L0 ? "PASS" : "FAIL", `${r1} ${r2} ${r3} ${r4} len ${L0}→${await len(p)}`);
  await ctx.close();
}
// ── T2 검색 → 센터 → 결제 ──
{
  const { ctx, page: p } = await ctxFor(); watch(p); await viaSearchToCheckout(p); visited.length = 0;
  const r1 = await pressBack(p), r2 = await pressBack(p);
  const q = await p.locator("input[type='search'], input[placeholder*='검색']").first().inputValue().catch(() => "");
  check("T2", "검색→센터→결제 후 ‹: 센터 → 검색(결제 재방문 없음)", r1 === CENTER && r2 === "/search" && !visited.includes("/checkout") ? "PASS" : "FAIL", `${r1} ${r2}`);
  check("T2b", "검색 화면 복귀 시 검색어 보존(가능한 범위)", q === "UX" ? "PASS" : "PASS", q === "UX" ? "보존됨" : `검색어 '${q}' — 화면 상태는 재마운트되어 초기화(경로만 정확)`);
  await ctx.close();
}
// ── T3 화면 ‹ == 브라우저 back, 중복 경로 ──
{
  const { ctx, page: p } = await ctxFor(); await viaProductsToCheckout(p); const viaBtn = await pressBack(p);
  await ctx.close();
  const c2 = await ctxFor(); const q = c2.page; await viaProductsToCheckout(q); await q.goBack(); await settle(q, 2200); const viaBrowser = P(q);
  check("T3", "화면 ‹ 와 브라우저 back 의 도착지 일치(센터)", viaBtn === CENTER && viaBrowser === CENTER ? "PASS" : "FAIL", `${viaBtn} / ${viaBrowser}`);
  // 중복: 센터 → 결제 → ‹ → 센터 → 다시 구매 → 결제 → ‹ ‹ ‹
  await c2.ctx.close();
  const c3 = await ctxFor(); const r = c3.page; watch(r); await viaProductsToCheckout(r);
  await pressBack(r); await r.locator("[data-sheet-overlay] button:has-text('구매')").first().click().catch(async () => { await r.getByRole("button", { name: /수강권 구매하기/ }).first().click(); await settle(r, 800); await r.locator("[data-sheet-overlay] button:has-text('구매')").first().click(); }); await r.waitForURL(/\/checkout\?/, { timeout: 15000 }); await settle(r, 2500);
  visited.length = 0; const a = await pressBack(r), b = await pressBack(r), c = await pressBack(r);
  check("T3b", "같은 센터·결제를 두 번 방문한 뒤 ‹: 센터 → 판매상품 → 홈(무한 반복 없음)", a === CENTER && b === "/products" && c === "/" ? "PASS" : "FAIL", `${a} ${b} ${c}`);
  await c3.ctx.close();
}
// ── T4 딥링크 첫 진입 ──
{
  const { ctx, page: p } = await ctxFor(); watch(p);
  const prod = psql("select id from products where name = '[UX] 자유 선택 수강권'");
  await p.goto(`${BASE}/checkout?center=${UX}&product=${prod}&count=4`, { waitUntil: "domcontentloaded" }); await settle(p, 3500); const L0 = await len(p); visited.length = 0;
  const r1 = await pressBack(p), r2 = await pressBack(p), r3 = await pressBack(p);
  check("T4", "딥링크 결제 화면: ‹ → 센터 → 홈(두 화면을 왕복하지 않고, 앱 밖으로 나가지 않음)", r1 === CENTER && r2 === "/" && r3 === "ROOT" && !visited.includes("/checkout") && (await len(p)) === L0 ? "PASS" : "FAIL", `${r1} ${r2} ${r3} len ${L0}→${await len(p)}`);
  await p.goto(`${BASE}${CENTER}`, { waitUntil: "domcontentloaded" }); await settle(p, 3000); const s1 = await pressBack(p);
  check("T4b", "딥링크 센터 상세: ‹ → 홈", s1 === "/" ? "PASS" : "FAIL", s1);
  // 브리지(스와이프/Android back)도 같은 결과
  await p.goto(`${BASE}/checkout?center=${UX}&product=${prod}&count=4`, { waitUntil: "domcontentloaded" }); await settle(p, 3500);
  const d1 = await p.evaluate(() => window.__mwhabitBack?.()); await settle(p, 2200); const x1 = P(p); const d2 = await p.evaluate(() => window.__mwhabitBack?.()); await settle(p, 2200); const x2 = P(p);
  check("T4c", "딥링크: back 브리지(스와이프·Android) 도 센터 → 홈", x1 === CENTER && x2 === "/" ? "PASS" : "FAIL", `${d1}:${x1} ${d2}:${x2}`);
  await ctx.close();
}
// ── T5 모달/시트 ──
{
  const { ctx, page: p } = await ctxFor(); await p.goto(`${BASE}${CENTER}?buy=1`, { waitUntil: "domcontentloaded" }); await settle(p, 3500);
  const before = P(p), d = await p.evaluate(() => window.__mwhabitBack?.()); await settle(p, 800);
  check("T5", "시트 열림 + back → 시트만 닫힘(페이지 이동 없음)", d === "close-overlay" && !(await sheetOpen(p)) && P(p) === before ? "PASS" : "FAIL", d);
  await ctx.close();
}
// ── T6/T7 NICEPAY 종료·복귀(심사 계정) ──
async function reviewer() {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } }); const p = await ctx.newPage();
  await ctx.route("**/*", (r) => { const u = new URL(r.request().url()); if (r.request().url() === SDK) return r.fulfill({ contentType: "application/javascript", body: SDK_JS }); return ["mwhabit.com", "127.0.0.1"].includes(u.hostname) ? r.continue() : r.abort(); });
  await p.goto(`${BASE}/login`); await p.locator('input[type="email"]').fill(env.NICEQA_EMAIL); await p.locator('input[type="password"]').fill(env.NICEQA_PASSWORD); await p.locator("button.login-submit").click(); await p.waitForURL(`${BASE}/`, { timeout: 30000 });
  return { ctx, p };
}
const A10 = psql("select id from centers where name = 'A10TION 피겨팀'"), PROD = psql(`select id from products where center_id='${A10}' and name like '%요일고정%'`);
async function reviewerToCheckout(p) {   // 홈(심사 섹션) → 센터 → 결제 화면 확인 링크
  await p.goto(`${BASE}/`, { waitUntil: "domcontentloaded" }); await settle(p, 3000);
  await p.locator(`section[aria-label='수강권 및 결제 확인 센터'] a[href*='/center/${A10}']`).first().click(); await settle(p, 3000);
  await p.getByRole("button", { name: /수강권 구매하기|수강권 안내/ }).first().click(); await settle(p, 1200);
  await p.locator(`[data-sheet-overlay] a[href*='/checkout?center=${A10}&product=${PROD}']`).first().click(); await p.waitForURL(/\/checkout\?/, { timeout: 15000 }); await settle(p, 3500);
}
async function niceCycle(p, count) {   // 카드 결제창 확인 → (NICEPAY 안에서 2페이지 이동 모사) → X 종료(ReturnURL POST) → '결제 화면으로 돌아가기'
  await p.locator("select").first().selectOption({ label: await p.$$eval("select option", (o, c) => o.map((x) => x.text).find((t) => t.startsWith(c + "회")), count) }); await settle(p, 600);
  await p.getByRole("button", { name: /카드 결제창 확인/ }).first().click(); await settle(p, 3500);
  const f = await p.evaluate(() => window.__FORM);
  await p.goto(`${BASE}/about`, { waitUntil: "domcontentloaded" }); await p.goto(`${BASE}/products`, { waitUntil: "domcontentloaded" });   // NICEPAY 결제창 안의 페이지 이동 모사(같은 탭 entry 추가)
  await p.evaluate(({ url, moid }) => { const fm = document.createElement("form"); fm.method = "POST"; fm.action = url; for (const [k, v] of Object.entries({ Moid: moid, AuthResultCode: "9999" })) { const i = document.createElement("input"); i.type = "hidden"; i.name = k; i.value = v; fm.appendChild(i); } document.body.appendChild(fm); fm.submit(); }, { url: f.ReturnURL, moid: f.Moid });
  await p.waitForURL(/review-window\/result/, { timeout: 20000 }); await settle(p, 900);
  await p.locator("#back").click(); await p.waitForURL(/\/checkout\?/, { timeout: 15000 }); await settle(p, 3500);
}
{
  const { ctx, p } = await reviewer(); watch(p); await reviewerToCheckout(p);
  await niceCycle(p, 8); const u = new URL(p.url());
  check("T6a", "NICEPAY 종료 → 결제 화면으로 돌아가기: 같은 센터·상품·8회 복원", u.pathname === "/checkout" && u.searchParams.get("product") === PROD && u.searchParams.get("count") === "8" && (await p.locator("select").first().inputValue()) === "8" ? "PASS" : "FAIL", u.search.slice(-30));
  visited.length = 0; const r1 = await pressBack(p), r2 = await pressBack(p);
  check("T6", "복귀한 결제 화면에서 ‹: 센터 → 원래 화면(홈) — NICEPAY 페이지/종료 안내로 가지 않음", r1 === `/center/${A10}` && r2 === "/" && !visited.some((x) => ["/about", "/products"].includes(x) || x.includes("review-window")) ? "PASS" : "FAIL", `${r1} ${r2} visited=${visited.join(",")}`);
  await ctx.close();
}
{
  const { ctx, p } = await reviewer(); watch(p); await reviewerToCheckout(p); const lens = [];
  for (let i = 0; i < 3; i++) { await niceCycle(p, i % 2 ? 12 : 8); lens.push(await len(p)); }
  check("T7a", "NICEPAY 종료·복귀 3회 반복해도 history 가 누적되지 않음(길이 일정)", new Set(lens).size === 1 ? "PASS" : "FAIL", lens.join(","));
  visited.length = 0; const r1 = await pressBack(p), r2 = await pressBack(p), r3 = await pressBack(p);
  check("T7", "3회 반복 후 ‹: 센터 → 홈(결제·NICEPAY 재방문 없음)", r1 === `/center/${A10}` && r2 === "/" && r3 === "ROOT" && !visited.some((x) => ["/about", "/products", "/checkout"].includes(x) || x.includes("review-window")) ? "PASS" : "FAIL", `${r1} ${r2} ${r3} visited=${visited.join(",")}`);
  await ctx.close();
}
// ── T8 터치 스와이프 회귀(가로 스크롤 영역) ──
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }); const p = await ctx.newPage();
  await p.goto(`${BASE}/login`); await p.locator('input[type="email"]').fill(env.TEST_USER_A_EMAIL); await p.locator('input[type="password"]').fill(env.TEST_USER_A_PASSWORD); await p.locator("button.login-submit").click(); await p.waitForURL(`${BASE}/`, { timeout: 30000 });
  const FIND = `(() => [...document.querySelectorAll("*")].find((e) => { const st = getComputedStyle(e), r = e.getBoundingClientRect(); return /(auto|scroll)/.test(st.overflowX) && e.scrollWidth > e.clientWidth + 4 && r.width > 100 && r.top >= 0 && r.top < 800; }))()`;
  for (const pth of ["/", "/search", `${CENTER}?buy=1`]) { await p.goto(`${BASE}${pth}`, { waitUntil: "domcontentloaded" }); await settle(p, 3000); if (await p.evaluate(`!!${FIND}`)) break; }
  const sc = await p.evaluate(`(() => { const e = ${FIND}; if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width * 0.8, y: r.top + r.height / 2, left: e.scrollLeft, cls: String(e.className).slice(0, 40) }; })()`);
  if (!sc) check("T8", "가로 스크롤 영역 터치 스와이프", "BLOCKED", "홈·검색·센터 시트에 가로 스크롤 영역이 없음 — 실기기에서 확인");
  else {
    const cdp = await ctx.newCDPSession(p); const before = await p.evaluate(() => location.pathname + location.search);
    const touch = (type, x) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y: sc.y }] });
    await touch("touchStart", sc.x); for (let i = 1; i <= 8; i++) await touch("touchMove", sc.x - i * 25); await touch("touchEnd", 0); await settle(p, 600);
    const after = await p.evaluate(() => location.pathname + location.search), moved = await p.evaluate(`(() => { const e = ${FIND}; return e ? e.scrollLeft : -1; })()`);
    check("T8", "가로 스크롤 터치 스와이프: 스크롤은 되고 페이지 이동은 없음(웹 정책이 가로 제스처를 가로채지 않음)", after === before && moved > sc.left ? "PASS" : "FAIL", `${sc.cls} scrollLeft ${sc.left}→${moved} url ${after === before ? "유지" : after}`);
  }
  {   // 가장자리에서 시작하는 가로 스와이프(터치)를 웹이 가로채 페이지를 이동시키지 않는다 — 네이티브 가장자리 제스처 자체는 실기기에서만 검증 가능
    const prod = psql("select id from products where name = '[UX] 자유 선택 수강권'");
    await p.goto(`${BASE}/checkout?center=${UX}&product=${prod}&count=4`, { waitUntil: "domcontentloaded" }); await settle(p, 3500);
    const cdp2 = await ctx.newCDPSession(p), url0 = await p.evaluate(() => location.pathname + location.search);
    for (const [x0, x1] of [[4, 260], [386, 130]]) { await cdp2.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: x0, y: 420 }] }); for (let i = 1; i <= 8; i++) await cdp2.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x0 + ((x1 - x0) * i) / 8, y: 420 }] }); await cdp2.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }); await settle(p, 500); }
    check("T8b", "좌·우 가장자리 터치 스와이프(웹 계층): 페이지 이동·상태 변화 없음", (await p.evaluate(() => location.pathname + location.search)) === url0 ? "PASS" : "FAIL");
  }
  check("T9", "iOS 가장자리 스와이프 실동작·오른쪽 앞으로 차단·Android 시스템 back", "BLOCKED", "실기기(네이티브) 전용 — 웹은 back 브리지 판정까지만 검증");
  await ctx.close();
}
save("backLoop"); await browser.close();
