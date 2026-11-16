/*
  수강권 안내창(센터 구매 시트) 드래그 닫기·오버스크롤·가장자리 스와이프 QA(실제 Chromium 터치 이벤트). 사용: ISO_ENV_FILE=<env> OUT=<dir> node tests/qa/sheetDrag/suite.mjs
  전제: 격리 스택 + localUxFixture.sql + next start(3216)/https 프록시(3217) — docs/qa/ux-final-20261109/REPORT.md. iOS WKWebView rubber-band·네이티브 가장자리 제스처 자체는 실기기 전용(BLOCKED).
*/
import { BASE, UX, browser, settle, check, save, env, OUT } from "../uxIntegration/lib.mjs";
const SHEET = "[data-sheet-overlay] .sheet";
async function login(w) {
  const ctx = await browser.newContext({ viewport: { width: w, height: 844 }, hasTouch: true, isMobile: true }); const p = await ctx.newPage();
  await ctx.route("**/*", (r) => ["mwhabit.com", "127.0.0.1"].includes(new URL(r.request().url()).hostname) ? r.continue() : r.abort());
  await p.goto(`${BASE}/login`); await p.locator('input[type="email"]').fill(env.TEST_USER_A_EMAIL); await p.locator('input[type="password"]').fill(env.TEST_USER_A_PASSWORD); await p.locator("button.login-submit").click(); await p.waitForURL(`${BASE}/`, { timeout: 30000 });
  return { ctx, p, cdp: await ctx.newCDPSession(p) };
}
const open = async (p) => { await p.goto(`${BASE}/center/${UX}`, { waitUntil: "domcontentloaded" }); await settle(p, 3000); await p.getByRole("button", { name: /수강권 구매하기|수강권 안내/ }).first().click(); await settle(p, 900); };
const isOpen = (p) => p.evaluate(() => !!document.querySelector("[data-sheet-overlay]"));
const metrics = (p) => p.evaluate((S) => { const s = document.querySelector(S); if (!s) return null; const r = s.getBoundingClientRect(); return { top: Math.round(r.top), h: Math.round(r.height), tf: s.style.transform, scrollTop: s.scrollTop, canScroll: s.scrollHeight > s.clientHeight + 4, bg: document.querySelector("[data-sheet-overlay]").style.backgroundColor, bodyOv: document.body.style.overflow, winY: window.scrollY, vvTop: window.visualViewport?.offsetTop ?? 0 }; }, SHEET);
async function swipe(cdp, x, y0, y1, { steps = 12, end = true } = {}) {
  const pt = (y) => [{ x, y: Math.round(y) }];
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: pt(y0) });
  for (let i = 1; i <= steps; i++) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: pt(y0 + ((y1 - y0) * i) / steps) });
  if (end) await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}
const hswipe = async (cdp, y, x0, x1) => { await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: x0, y }] }); for (let i = 1; i <= 10; i++) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x0 + ((x1 - x0) * i) / 10, y }] }); await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }); };
const watch = (p) => p.evaluate(() => { window.__tm = []; document.addEventListener("touchmove", (e) => window.__tm.push({ prevented: e.defaultPrevented, inSheet: !!e.target.closest?.(".sheet") }), { passive: false }); });

{
  const { ctx, p, cdp } = await login(390); await open(p); await watch(p);
  const m0 = await metrics(p); const url0 = p.url();
  check("Q1", "수강권 안내창 열기 + 드래그 핸들·스크롤 가능한 긴 본문", m0 && (await p.locator(".sheet-drag-handle").count()) === 1 && m0.canScroll ? "PASS" : "FAIL", JSON.stringify({ h: m0?.h, canScroll: m0?.canScroll }));
  await p.screenshot({ path: `${OUT}/sheet-open-390.png` });
  const hb = await p.locator(".sheet-drag-handle").boundingBox(); const hx = hb.x + hb.width / 2, hy = hb.y + hb.height / 2;
  // Q3 조금만 드래그 → 원위치
  await swipe(cdp, hx, hy, hy + 70, { end: false }); await settle(p, 200); const mid = await metrics(p); await p.screenshot({ path: `${OUT}/sheet-dragging-handle-390.png` });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }); await settle(p, 700); const back = await metrics(p);
  check("Q3", "핸들을 조금만 끌면 시트 전체가 따라 내려가다가(딤도 옅어짐) 놓으면 원위치로 복귀", mid && mid.tf.includes("translateY") && back && back.tf === "" && back.top === m0.top && (await isOpen(p)) ? "PASS" : "FAIL", `mid=${mid?.tf} bg=${mid?.bg} → top ${back?.top}/${m0.top}`);
  // Q2 핸들 아래로 충분히 → 닫힘
  await swipe(cdp, hx, hy, hy + 420); await settle(p, 900);
  check("Q2", "핸들을 아래로 충분히 끌면 시트가 아래로 내려가며 닫히고 센터 화면·주소·배경 스크롤 위치 유지", !(await isOpen(p)) && p.url() === url0 && (await p.evaluate(() => document.body.style.overflow)) === "" ? "PASS" : "FAIL", `open=${await isOpen(p)} overflow='${await p.evaluate(() => document.body.style.overflow)}'`);
  // Q4 본문 스크롤(손가락 위로) / 맨 위가 아니면 아래로 밀어도 스크롤 우선
  await open(p); await watch(p); const sb = await p.locator(SHEET).boundingBox(); const cx = sb.x + sb.width / 2;
  await swipe(cdp, cx, sb.y + 520, sb.y + 220); await settle(p, 400); const s1 = await metrics(p);
  check("Q4", "긴 본문에서 손가락을 위로 밀면 본문이 정상 스크롤(시트는 움직이지 않음)", s1.scrollTop > 40 && s1.tf === "" ? "PASS" : "FAIL", `scrollTop ${s1.scrollTop} tf='${s1.tf}'`);
  await swipe(cdp, cx, sb.y + 260, sb.y + 380); await settle(p, 400); const s2 = await metrics(p);
  check("Q4b", "스크롤이 맨 위가 아닐 때는 아래로 밀어도 본문이 먼저 스크롤된다(시트 드래그로 전환되지 않음)", s2.scrollTop < s1.scrollTop && s2.tf === "" && (await isOpen(p)) ? "PASS" : "FAIL", `scrollTop ${s1.scrollTop}→${s2.scrollTop}`);
  // Q5 맨 위에서 본문 아래로 드래그 → 닫힘
  await p.evaluate((S) => { document.querySelector(S).scrollTop = 0; }, SHEET); await settle(p, 200);
  await swipe(cdp, cx, sb.y + 160, sb.y + 160 + 420, { end: false }); await settle(p, 200); const d = await metrics(p); await p.screenshot({ path: `${OUT}/sheet-dragging-content-390.png` });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }); await settle(p, 900);
  check("Q5", "스크롤 최상단에서 본문을 아래로 끌면 시트 드래그로 전환되어 닫힘", d && d.tf.includes("translateY") && !(await isOpen(p)) ? "PASS" : "FAIL", `mid=${d?.tf} closed=${!(await isOpen(p))}`);
  await ctx.close();
}
{ // Q6 반복, Q9 흰 영역(배경 당김) 차단, Q11 가로 스와이프
  const { ctx, p, cdp } = await login(390); let ok = true, why = "";
  for (let i = 0; i < 5; i++) {
    await open(p); const sb = await p.locator(SHEET).boundingBox(); const hb = await p.locator(".sheet-drag-handle").boundingBox();
    if (i % 2) await swipe(cdp, hb.x + hb.width / 2, hb.y + 8, hb.y + 8 + 420); else await swipe(cdp, sb.x + sb.width / 2, sb.y + 150, sb.y + 150 + 420);
    await settle(p, 900); if (await isOpen(p)) { ok = false; why = `반복 ${i + 1}회차 닫히지 않음`; break; }
  }
  const lock = await p.evaluate(() => ({ ov: document.body.style.overflow, n: document.querySelectorAll("[data-sheet-overlay]").length }));
  check("Q6", "열고 닫기를 5회 반복(핸들/본문 번갈아) — 매번 닫히고 body 잠금·오버레이 잔여 없음", ok && lock.ov === "" && lock.n === 0 ? "PASS" : "FAIL", why || JSON.stringify(lock));
  await open(p); await watch(p); const sb = await p.locator(SHEET).boundingBox();
  await swipe(cdp, sb.x + sb.width / 2, 5, 300, { steps: 8 });   // 시트 위 딤 영역(시트 상단 위 약 16px)에서 시작해 아래로 — 시트 밖 터치
  await settle(p, 700);
  await p.evaluate((S) => { const s = document.querySelector(S); s.scrollTop = s.scrollHeight; }, SHEET); await settle(p, 200);
  await swipe(cdp, sb.x + sb.width / 2, sb.y + 500, sb.y + 200, { steps: 8 });   // 스크롤 끝단에서 위로(끝단 초과)
  const tm = await p.evaluate(() => window.__tm), m = await metrics(p);
  const outside = tm.filter((t) => !t.inSheet), endbound = tm.slice(-8);
  check("Q9", "시트 밖(딤 영역) 터치와 스크롤 끝단 초과 터치는 preventDefault — 배경 문서가 당겨져 흰 빈 영역이 생기지 않음", outside.length > 0 && outside.every((t) => t.prevented) && endbound.every((t) => t.prevented) && m.winY === 0 && m.vvTop === 0 ? "PASS" : "FAIL", `outside ${outside.filter((t) => t.prevented).length}/${outside.length}, end ${endbound.filter((t) => t.prevented).length}/${endbound.length}, winY=${m.winY}`);
  await p.evaluate((S) => { document.querySelector(S).scrollTop = 0; }, SHEET);
  await hswipe(cdp, sb.y + 250, 300, 60); await settle(p, 400); const hm = await metrics(p);
  check("Q11", "시트 안 가로 스와이프는 시트를 끌거나 닫지 않음(가로 스크롤·텍스트 터치 유지)", hm && hm.tf === "" && (await isOpen(p)) ? "PASS" : "FAIL", `tf='${hm?.tf}'`);
  await ctx.close();
}
{ // Q7 왼쪽 가장자리 스와이프(네이티브 → window.__mwhabitBack 입구) / Q8 닫힌 상태 정상 back
  const { ctx, p } = await login(390);
  await p.goto(`${BASE}/`, { waitUntil: "domcontentloaded" }); await settle(p, 2500); await p.getByRole("link", { name: "판매 상품" }).first().click(); await settle(p, 2500);
  await p.locator(`a[href*='/center/${UX}']`).first().click(); await settle(p, 3000);
  const open0 = await isOpen(p), url0 = p.url();
  const e1 = await p.evaluate(() => window.__mwhabitBackEdge?.()); await settle(p, 800);
  check("Q7", "시트가 열린 동안 왼쪽 가장자리 스와이프(edge 입구)는 시트를 닫지도 화면을 이동시키지도 않음", open0 && e1 === "blocked-by-overlay" && (await isOpen(p)) && p.url() === url0 ? "PASS" : "FAIL", `${e1} open=${await isOpen(p)}`);
  const sys = await p.evaluate(() => window.__mwhabitBack?.()); await settle(p, 800);
  check("Q7b", "Android 시스템 back(기존 정책)은 시트를 닫는다 — 변경 없음", sys === "close-overlay" && !(await isOpen(p)) ? "PASS" : "FAIL", sys);
  const e2 = await p.evaluate(() => window.__mwhabitBackEdge?.()); await settle(p, 2500);
  check("Q8", "시트가 닫힌 일반 화면에서는 edge back 이 기존처럼 직전 화면(판매 상품)으로 이동", e2 === "history-back" && new URL(p.url()).pathname === "/products" ? "PASS" : "FAIL", `${e2} ${new URL(p.url()).pathname}`);
  await ctx.close();
}
for (const w of [360, 390, 430]) {   // Q10 레이아웃
  const { ctx, p } = await login(w); await open(p); const r = await p.evaluate((S) => { const s = document.querySelector(S).getBoundingClientRect(), d = document.documentElement; const bt = [...document.querySelectorAll(`${S} button`)].filter((b) => /^(담기|구매)$/.test(b.innerText.trim())).map((b) => b.getBoundingClientRect().height); return { w: Math.round(s.width), right: Math.round(s.right), ov: d.scrollWidth > d.clientWidth + 1, handle: !!document.querySelector(".sheet-drag-handle"), minBtn: Math.min(...bt), bottom: Math.round(s.bottom), vh: innerHeight }; }, SHEET);
  await p.screenshot({ path: `${OUT}/sheet-layout-${w}.png` });
  check(`Q10-${w}`, `${w}px: 시트가 화면 안에 있고 가로 넘침 없음·핸들 표시·버튼 높이≥44·하단 고정`, r.right <= w && !r.ov && r.handle && r.minBtn >= 44 && r.bottom <= r.vh + 1 ? "PASS" : "FAIL", JSON.stringify(r));
  await ctx.close();
}
check("Q13", "iOS WKWebView 실제 rubber-band(흰 영역)·네이티브 가장자리 제스처·오른쪽 앞으로 차단·Android 시스템 back 실동작", "BLOCKED", "실기기 전용 — 웹은 preventDefault 차단·입구 판정까지 검증");
save("sheetDrag"); await browser.close();
