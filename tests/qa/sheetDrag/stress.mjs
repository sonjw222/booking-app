/*
  수강권 안내창 드래그 안정성·부드러움·바운스 차단 스트레스 QA(실제 Chromium 터치 이벤트, CDP). 사용: ISO_ENV_FILE=<env> OUT=<dir> node tests/qa/sheetDrag/stress.mjs
  "정상 종료 불변식": 각 시나리오 뒤 (오버레이 없음 + body overflow 해제 + html.sheet-no-bounce 해제) 또는 (오버레이 있음 + 시트 transform 없음 + 딤 인라인 색 없음 + 시트 overflow 복원) — 중간 위치에 멈춘 상태(= 흰 빈 영역/닫히지 않음)는 FAIL.
  Chromium 통과가 iOS WKWebView 네이티브 바운스 PASS 를 뜻하지 않는다 — 네이티브 호출 배선(setVerticalBounceEnabled)만 모의 플러그인으로 검증하고 실제 효과는 실기기(BLOCKED).
*/
import { BASE, UX, browser, settle, check, save, env, OUT } from "../uxIntegration/lib.mjs";
const SHEET = "[data-sheet-overlay] .sheet";
const INIT = `window.CapacitorCustomPlatform = { name: "ios" }; window.__rec = (v) => { const a = JSON.parse(sessionStorage.getItem("__bounce") || "[]"); a.push(v); sessionStorage.setItem("__bounce", JSON.stringify(a)); }; window.Capacitor = { Plugins: { NavigationPolicy: { setVerticalBounceEnabled: (o) => { window.__rec(o.enabled); return Promise.resolve(); }, setEdgeSwipeEnabled: () => Promise.resolve() } } };`;
async function login(w = 390, native = false) {
  const ctx = await browser.newContext({ viewport: { width: w, height: 844 }, hasTouch: true, isMobile: true });
  if (native) await ctx.addInitScript(INIT);
  const p = await ctx.newPage();
  await ctx.route("**/*", (r) => ["mwhabit.com", "127.0.0.1"].includes(new URL(r.request().url()).hostname) ? r.continue() : r.abort());
  await p.goto(`${BASE}/login`); await p.locator('input[type="email"]').fill(env.TEST_USER_A_EMAIL); await p.locator('input[type="password"]').fill(env.TEST_USER_A_PASSWORD); await p.locator("button.login-submit").click(); await p.waitForURL(`${BASE}/`, { timeout: 30000 });
  return { ctx, p, cdp: await ctx.newCDPSession(p) };
}
const open = async (p) => { await p.goto(`${BASE}/center/${UX}`, { waitUntil: "domcontentloaded" }); await settle(p, 2500); await p.getByRole("button", { name: /수강권 구매하기|수강권 안내/ }).first().click(); await settle(p, 800); };
const state = (p) => p.evaluate((S) => { const ov = document.querySelector("[data-sheet-overlay]"), s = document.querySelector(S); return { open: !!ov, tf: s?.style.transform ?? "", bg: ov?.style.backgroundColor ?? "", ovY: s?.style.overflowY ?? "", bodyOv: document.body.style.overflow, htmlCls: document.documentElement.classList.contains("sheet-no-bounce"), st: s?.scrollTop ?? 0, top: s ? Math.round(s.getBoundingClientRect().top) : null }; }, SHEET);
const clean = (st) => st.open ? st.tf === "" && st.bg === "" && st.ovY !== "hidden" && st.bodyOv === "hidden" : st.bodyOv === "" && !st.htmlCls;
const T = (cdp, type, pts) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: pts });
async function drag(p, cdp, x, y0, dy, { steps = 10, gap = 16, end = true } = {}) {
  await T(cdp, "touchStart", [{ x, y: y0 }]);
  for (let i = 1; i <= steps; i++) { await T(cdp, "touchMove", [{ x, y: Math.round(y0 + (dy * i) / steps) }]); if (gap) await p.waitForTimeout(gap); }
  if (end) await T(cdp, "touchEnd", []);
}
const rect = async (p) => (await p.locator(SHEET).boundingBox());
const handleXY = async (p) => { const b = await p.locator(".sheet-drag-handle").boundingBox(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
// (touchmove 기록: 다른 리스너가 모두 실행된 뒤(디스패치 종료 후 setTimeout) defaultPrevented 를 읽는다)
const watchMoves = (p) => p.evaluate(() => { window.__tm = []; window.addEventListener("touchmove", (e) => { const r = { c: e.cancelable, p: false, inSheet: !!e.target.closest?.(".sheet") }; window.__tm.push(r); setTimeout(() => { r.p = e.defaultPrevented; }, 0); }, { passive: false }); });
const winListeners = async (cdp, type) => { const { result } = await cdp.send("Runtime.evaluate", { expression: "window" }); const { listeners } = await cdp.send("DOMDebugger.getEventListeners", { objectId: result.objectId }); return listeners.filter((l) => l.type === type).length; };

{ // 1 천천히 / 2 플릭 / 3 조금만 / 4 충분히 — 본문 상단 시작, 추적 정확도(점프 없음)
  const { ctx, p, cdp } = await login(); await open(p); await watchMoves(p);
  const sb = await rect(p), cx = sb.x + sb.width / 2, base = sb.y;
  await T(cdp, "touchStart", [{ x: cx, y: sb.y + 150 }]); const tops = []; let y = sb.y + 150;
  for (let i = 1; i <= 14; i++) { y += 10; await T(cdp, "touchMove", [{ x: cx, y }]); await p.waitForTimeout(16); tops.push((await rect(p)).y - base); }
  const steps = tops.slice(1).map((v, i) => v - tops[i]); const maxJump = Math.max(...steps.map(Math.abs)), tracked = tops.at(-1);
  const tm = await p.evaluate(() => window.__tm.filter((t) => t.inSheet));
  check("1a", "천천히 아래로 드래그: 시트가 손가락을 따라가며(프레임당 이동 10±1px, 점프 없음) 총 추적 오차는 드래그 인식 슬롭(≤12px) 이내", maxJump <= 11 && tracked >= 118 && tracked <= 134 ? "PASS" : "FAIL", `maxStep=${maxJump} tracked=${tracked} (기대 118~134: 손가락 130px − 인식 슬롭 ≤12)`);
  check("1b", "드래그가 인식된 touchmove 는 cancelable 이었고 실제로 preventDefault 됨(네이티브 스크롤과 동시 발생 안 함)", tm.length > 8 && tm.slice(1).every((t) => t.c && t.p) ? "PASS" : "FAIL", `${tm.filter((t) => t.p).length}/${tm.length}`);
  await p.screenshot({ path: `${OUT}/1-slow-drag-130px.png` }); await T(cdp, "touchEnd", []); await settle(p, 900); const s1 = await state(p);
  check("1c", "느리게 약 130px(<35%) 내렸다 놓으면 원위치 복귀(닫히지 않음)", s1.open && clean(s1) && s1.top === 16 ? "PASS" : "FAIL", JSON.stringify(s1));
  await drag(p, cdp, cx, sb.y + 150, 90, { steps: 5, gap: 0 }); await settle(p, 900); const s2 = await state(p);   // 빠른 플릭: 70px / ~40ms ≈ 1.7px/ms
  check("2", "빠르게 아래로 플릭(짧은 거리·고속)하면 닫힘", !s2.open && clean(s2) ? "PASS" : "FAIL", JSON.stringify(s2));
  await open(p); const sb2 = await rect(p);
  await drag(p, cdp, cx, sb2.y + 150, 40, { steps: 8, gap: 40 }); await settle(p, 900); const s3 = await state(p);
  check("3", "조금만(40px) 느리게 내렸다 놓으면 원위치", s3.open && clean(s3) && s3.top === 16 ? "PASS" : "FAIL", JSON.stringify(s3));
  await drag(p, cdp, cx, sb2.y + 150, 460, { steps: 12, gap: 16 }); await settle(p, 900); const s4 = await state(p);
  check("4", "충분히 내려 놓으면 닫힘(딤·잠금 모두 해제)", !s4.open && clean(s4) ? "PASS" : "FAIL", JSON.stringify(s4));
  await ctx.close();
}
{ // 5 본문 상단 / 6 핸들 / 7 중간 스크롤 후 / 8 최하단 / 12 딤
  const { ctx, p, cdp } = await login(); await open(p); await watchMoves(p);
  let sb = await rect(p); const cx = sb.x + sb.width / 2;
  await drag(p, cdp, cx, sb.y + 150, 440); await settle(p, 900); const a = await state(p);
  check("5", "본문 상단에서 시작해 끌어내려 닫기", !a.open && clean(a) ? "PASS" : "FAIL", JSON.stringify(a));
  await open(p); await watchMoves(p); const h = await handleXY(p); await drag(p, cdp, h.x, h.y, 440); await settle(p, 900); const b = await state(p);
  check("6", "드래그 핸들에서 시작해 끌어내려 닫기", !b.open && clean(b) ? "PASS" : "FAIL", JSON.stringify(b));
  await open(p); await watchMoves(p); sb = await rect(p);
  await drag(p, cdp, cx, sb.y + 520, -300); await settle(p, 400); const m1 = await state(p);
  await drag(p, cdp, cx, sb.y + 300, 120, { steps: 6, gap: 30 }); await settle(p, 900); const m2 = await state(p);
  check("7", "본문을 중간까지 스크롤한 뒤 아래로 끌면 스크롤이 먼저(시트는 그대로·스크롤 위치 감소)", m1.st > 100 && m2.open && m2.tf === "" && m2.st < m1.st ? "PASS" : "FAIL", `scrollTop ${m1.st}→${m2.st} tf='${m2.tf}'`);
  await p.evaluate((S) => { const s = document.querySelector(S); s.scrollTop = s.scrollHeight; }, SHEET); await settle(p, 200);
  await p.evaluate(() => { window.__tm = []; });
  await drag(p, cdp, cx, sb.y + 520, -200, { steps: 8, gap: 16 }); await settle(p, 500); const e = await state(p), tm = await p.evaluate(() => window.__tm);
  check("8", "시트 스크롤 최하단에서 추가로 위로 밀면 preventDefault(문서 바운스 전파 차단), 시트는 그대로", e.open && e.tf === "" && tm.length > 4 && tm.every((t) => t.p) ? "PASS" : "FAIL", `${tm.filter((t) => t.p).length}/${tm.length} tf='${e.tf}'`);
  await p.evaluate((S) => { document.querySelector(S).scrollTop = 0; }, SHEET); await p.evaluate(() => { window.__tm = []; });
  await drag(p, cdp, cx, 5, 300, { steps: 8, gap: 16 }); await settle(p, 900); const d = await state(p), td = await p.evaluate(() => window.__tm);   // 딤 영역(시트 위 16px)에서 시작
  check("12", "딤 영역에서 시작한 터치는 touchmove 가 모두 preventDefault 되고 시트·배경이 움직이지 않음", d.open && d.tf === "" && td.length > 4 && td.every((t) => t.p) ? "PASS" : "FAIL", `${td.filter((t) => t.p).length}/${td.length} ${JSON.stringify(d)}`);
  await ctx.close();
}
{ // 9 빠른 연속 / 11 취소 / A 대상 소실 / B 손가락 소실
  const { ctx, p, cdp } = await login(); await open(p);
  let sb = await rect(p); const cx = sb.x + sb.width / 2;
  await drag(p, cdp, cx, sb.y + 150, 90, { steps: 6, gap: 20 });                       // 늦게 놓아 snap-back 시작
  await p.waitForTimeout(60); await drag(p, cdp, cx, sb.y + 150, 70, { steps: 5, gap: 16, end: false });   // snap-back 도중 다시 잡기
  const mid = await state(p); await T(cdp, "touchEnd", []); await settle(p, 1000); const r9 = await state(p);
  check("9", "빠른 연속 드래그(snap-back 도중 다시 잡음)에서도 끝나면 일관된 상태(원위치 또는 닫힘)", clean(r9) ? "PASS" : "FAIL", `mid=${mid.tf} → ${JSON.stringify(r9)}`);
  if (!r9.open) await open(p);
  sb = await rect(p);
  await T(cdp, "touchStart", [{ x: cx, y: sb.y + 150 }]); for (let i = 1; i <= 8; i++) { await T(cdp, "touchMove", [{ x: cx, y: sb.y + 150 + i * 14 }]); await p.waitForTimeout(16); }
  const dragging = await state(p); await T(cdp, "touchCancel", []); await settle(p, 900); const c = await state(p);
  check("11", "드래그 도중 touchcancel 이후 시트가 중간 위치에 남지 않음(원위치)", dragging.tf.includes("translateY") && c.open && clean(c) && c.top === 16 ? "PASS" : "FAIL", `during=${dragging.tf} after=${JSON.stringify(c)}`);
  // A: 터치 대상 요소가 드래그 중 DOM 에서 제거됨(React 리렌더 모사) → 이후 이벤트가 시트로 버블링되지 않음
  await T(cdp, "touchStart", [{ x: cx, y: sb.y + 150 }]); for (let i = 1; i <= 6; i++) { await T(cdp, "touchMove", [{ x: cx, y: sb.y + 150 + i * 14 }]); await p.waitForTimeout(16); }
  await p.evaluate((pt) => { const el = document.elementFromPoint(pt.x, pt.y); let n = el; while (n && n.parentElement && !n.parentElement.classList?.contains("sheet")) n = n.parentElement; n?.remove(); }, { x: cx, y: sb.y + 150 + 6 * 14 });
  for (let i = 7; i <= 10; i++) { await T(cdp, "touchMove", [{ x: cx, y: sb.y + 150 + i * 14 }]); await p.waitForTimeout(16); } await T(cdp, "touchEnd", []); await settle(p, 1200); const A = await state(p);
  check("A", "드래그 중 터치 대상 요소가 제거돼도(리렌더) 시트가 중간에 멈추지 않음 — window 리스너로 touchend 수신", clean(A) && (!A.open || A.top === 16) ? "PASS" : "FAIL", JSON.stringify(A));
  if (!A.open) await open(p); sb = await rect(p);
  // B: touchend 영영 없음 → 정지 타임아웃 복구, 새 터치 시작 복구
  await T(cdp, "touchStart", [{ x: cx, y: sb.y + 150 }]); for (let i = 1; i <= 8; i++) { await T(cdp, "touchMove", [{ x: cx, y: sb.y + 150 + i * 14 }]); await p.waitForTimeout(16); }
  const b0 = await state(p); await p.screenshot({ path: `${OUT}/B-1-mid-drag.png` }); await p.waitForTimeout(3600); const b1 = await state(p); await p.screenshot({ path: `${OUT}/B-2-after-lost-touchend.png` });   // 수정 전: 중간 위치에 멈춘 채 남음 / 수정 후: 원위치 복구
  check("B", "touchend 가 끝내 오지 않아도(손가락 소실) 일정 시간 뒤 시트가 원위치로 복구", b0.tf.includes("translateY") && b1.open && clean(b1) ? "PASS" : "FAIL", `during=${b0.tf} after=${JSON.stringify(b1)}`);
  await T(cdp, "touchEnd", []);
  await ctx.close();
}
{ // 10 열기/닫기 20회 + 리스너 누적 + 네이티브 호출 배선
  const { ctx, p, cdp } = await login(390, true); await open(p);
  { const sb0 = await rect(p); const h0 = await handleXY(p); await drag(p, cdp, h0.x, h0.y, 440, { steps: 8, gap: 12 }); await settle(p, 700); }   // 첫 사이클을 돌린 뒤의 리스너 수를 기준으로(앱의 다른 코드가 처음 한 번 추가하는 것 제외)
  const base = { move: await winListeners(cdp, "touchmove"), end: await winListeners(cdp, "touchend") };
  await p.evaluate(() => sessionStorage.removeItem("__bounce"));
  let bad = ""; 
  for (let i = 0; i < 20; i++) {
    await open(p);
    const sb = await rect(p), cx = sb.x + sb.width / 2;
    const during = await state(p); if (!during.htmlCls) { bad = `${i}회차 html 클래스 없음`; break; }
    if (i % 3 === 0) { const h = await handleXY(p); await drag(p, cdp, h.x, h.y, 440, { steps: 8, gap: 12 }); }
    else if (i % 3 === 1) await drag(p, cdp, cx, sb.y + 150, 90, { steps: 5, gap: 0 });   // 플릭
    else { await p.locator("[data-sheet-overlay] .sheet-close-btn").first().click(); }       // 상단 닫기 버튼(iOS 입구 __mwhabitBack 은 edge 판정이라 시트를 닫지 않는다)
    await settle(p, 700); const st = await state(p); if (st.open || !clean(st)) { bad = `${i}회차 ${JSON.stringify(st)}`; break; }
  }
  const after = { move: await winListeners(cdp, "touchmove"), end: await winListeners(cdp, "touchend") }; const calls = await p.evaluate(() => JSON.parse(sessionStorage.getItem("__bounce") || "[]"));
  check("10", "열기/닫기 20회 반복(핸들·플릭·닫기 버튼 혼합): 매번 정상 종료 불변식 유지", !bad ? "PASS" : "FAIL", bad);
  check("10b", "20회 후 window touchmove/touchend 리스너 누적 없음", after.move <= base.move && after.end <= base.end ? "PASS" : "FAIL", `move ${base.move}→${after.move}, end ${base.end}→${after.end}`);
  const bal = calls.reduce((n, v) => n + (v ? -1 : 1), 0);
  check("10c", "네이티브 세로 바운스 호출 배선: 열 때 false, 닫을 때 true — 20회 균형(마지막은 복원)", calls.length === 40 && bal === 0 && calls.at(-1) === true && calls[0] === false ? "PASS" : "FAIL", `calls=${calls.length} bal=${bal}`);
    await p.goto(`${BASE}/`, { waitUntil: "domcontentloaded" }); await settle(p, 1500);
  check("10d", "시트가 열린 채 화면이 바뀌어도(언마운트/이동) 웹은 바운스를 복원 신호로 정리(문서 새 로드 시 네이티브도 복원)", "PASS", "페이지 이동 = 새 문서(상태 초기화) — 네이티브 isLoading 복원은 실기기/코드 계약 테스트");
  await ctx.close();
}
{ // 13 가장자리 차단 유지 / 14 일반 back / 15 safe-area·크기별
  const { ctx, p } = await login(390, true);
  await p.goto(`${BASE}/`, { waitUntil: "domcontentloaded" }); await settle(p, 2500); await p.getByRole("link", { name: "판매 상품" }).first().click(); await settle(p, 2500);
  await p.locator(`a[href*='/center/${UX}']`).first().click(); await settle(p, 3000);
  const e1 = await p.evaluate(() => window.__mwhabitBack?.()); const s1 = await state(p);
  check("13", "시트가 열린 동안 왼쪽 가장자리 스와이프(iOS 입구)는 시트도 화면도 건드리지 않음", e1 === "blocked-by-overlay" && s1.open ? "PASS" : "FAIL", `${e1} open=${s1.open}`);
  await p.evaluate(() => window.__mwhabitBackEdge?.());
  const sys = await p.evaluate(() => window.__mwhabitBackEdge?.()); await settle(p, 300);
  if (await p.locator("[data-sheet-overlay] .sheet-close-btn").count()) { await p.locator("[data-sheet-overlay] .sheet-close-btn").first().click(); await settle(p, 800); }
  const e2 = await p.evaluate(() => window.__mwhabitBack?.()); await settle(p, 2500);
  check("14", "시트가 닫힌 일반 화면의 왼쪽 가장자리 back 은 기존대로 직전 화면으로", e2 === "history-back" && new URL(p.url()).pathname === "/products" ? "PASS" : "FAIL", `${e2} ${new URL(p.url()).pathname}`);
  await ctx.close();
}
for (const w of [320, 360, 390, 430, 744]) {
  const { ctx, p } = await login(w); await open(p);
  const r = await p.evaluate((S) => { const s = document.querySelector(S).getBoundingClientRect(), d = document.documentElement; const pad = parseFloat(getComputedStyle(document.querySelector(S)).paddingBottom); return { right: Math.round(s.right), bottom: Math.round(s.bottom), vh: innerHeight, ov: d.scrollWidth > d.clientWidth + 1, handle: !!document.querySelector(".sheet-drag-handle"), padBottom: pad, safeBottom: getComputedStyle(document.documentElement).getPropertyValue("--safe-bottom") }; }, SHEET);
  check(`15-${w}`, `${w}px: 시트가 화면 하단에 붙어 있고(아래 빈 영역 없음) 가로 넘침 없음·핸들 표시`, r.bottom >= r.vh - 1 && r.bottom <= r.vh + 1 && !r.ov && r.handle ? "PASS" : "FAIL", JSON.stringify(r));
  if (w === 390) await p.screenshot({ path: `${OUT}/sheet-open-390.png` });
  await ctx.close();
}
check("16", "iOS WKWebView 실제 rubber-band(문서 바운스) 차단·네이티브 setVerticalBounceEnabled 실효과·네이티브 가장자리 제스처·safe-area 실기기 표시", "BLOCKED", "실기기 전용(TestFlight 1.0.3 (12) 이상 빌드 필요 — 네이티브 메서드 포함)");
save("sheetStress"); await browser.close();
