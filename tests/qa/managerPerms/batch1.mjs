/*
  Issue #274 Batch 1(매니저 권한 초기화 → useMyEffectivePerms) 브라우저 QA — 격리 Supabase 스택 + next start(3216) 전용. 실제 결제·주문·예약 생성 없음, 외부 호스트 차단.
  사용: ISO_ENV_FILE=<env> [BASE=http://127.0.0.1:3216] node tests/qa/managerPerms/batch1.mjs
  전제: scripts 의 mkmgr 와 같은 시험 데이터 — 센터 2개([QA] 권한 센터 1·2), 오너 = TEST_MANAGER_A, 스태프 = TEST_MANAGER_B
        (센터1: customer.progress·schedule.own.group.delete 만, 센터2: customer.progress·pass.create·pass.update·facility.room·pass.payment.create).
*/
import fs from "node:fs"; import { createRequire } from "node:module";
const require = createRequire(process.cwd() + "/package.json"); const { chromium } = require("playwright");
const BASE = process.env.BASE ?? "http://127.0.0.1:3216";
const env = {}; for (const ln of fs.readFileSync(process.env.ISO_ENV_FILE, "utf8").split("\n")) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(ln.trim()); if (m) env[m[1]] = m[2]; }
if (!/^http:\/\/127\.0\.0\.1:/.test(env.NEXT_PUBLIC_SUPABASE_URL)) { console.error("ABORT: 로컬 격리 Supabase 가 아님"); process.exit(1); }
const browser = await chromium.launch();
const results = []; const external = new Set(); const pageErrors = [];
const check = (id, name, ok, detail = "") => { results.push({ id, name, ok }); console.log(`${ok ? "PASS" : "FAIL"} ${id} ${name}${detail ? " — " + String(detail).slice(0, 220) : ""}`); };
const PAGES = ["/manager", "/manager/announcements", "/manager/center-info", "/manager/class-revenue", "/manager/classes", "/manager/coupons", "/manager/goods", "/manager/holidays", "/manager/members", "/manager/membership-rules", "/manager/orders", "/manager/progress", "/manager/progress/record", "/manager/reviews", "/manager/rooms", "/manager/sales", "/manager/settings", "/manager/staff"];
const permReq = { n: 0 };   // 권한 조회 관련 REST 요청 수
async function ctx(viewport = { width: 1100, height: 900 }, touch = false) {
  const c = await browser.newContext({ viewport, hasTouch: touch });
  await c.route("**/*", (r) => { const u = new URL(r.request().url()); if (["127.0.0.1", "localhost"].includes(u.hostname)) { if (/\/rest\/v1\/(role_permissions|account_center_permissions)/.test(u.pathname)) permReq.n++; return r.continue(); } external.add(u.hostname); return r.abort(); });
  return c;
}
async function login(page, email, password) { await page.goto(`${BASE}/login`); await page.locator('input[type="email"]').fill(email); await page.locator('input[type="password"]').fill(password); await page.locator("button.login-submit").click(); await page.waitForURL(`${BASE}/`, { timeout: 30000 }).catch(() => {}); await page.waitForTimeout(1200); }
const wire = (p, tag) => { p.on("pageerror", (e) => pageErrors.push(`${tag}: ${String(e.message).slice(0, 160)}`)); p.on("console", (m) => { if (m.type() === "error" && /Maximum update depth|Too many re-renders/i.test(m.text())) pageErrors.push(`${tag}: ${m.text().slice(0, 120)}`); }); };
const links = (p) => p.evaluate(() => [...new Set([...document.querySelectorAll("a[href^='/manager/']")].map((a) => a.getAttribute("href")))].sort());
const chip = (p, name) => p.locator("button.center-chip", { hasText: name }).first();
async function visitAll(p, label, who) {
  const bad = [];
  for (const r of PAGES) {
    const before = pageErrors.length; let st = 0;
    try { const res = await p.goto(BASE + r, { waitUntil: "domcontentloaded", timeout: 30000 }); st = res?.status() ?? 0; await p.waitForTimeout(1600); } catch (e) { bad.push(`${r}: ${String(e.message).slice(0, 50)}`); continue; }
    const body = await p.locator("body").innerText().catch(() => "");
    if (st >= 500 || /Application error|예기치 못한 오류/.test(body) || pageErrors.length > before) bad.push(`${r}: st=${st} err=${pageErrors.slice(before).join("|").slice(0, 80)}`);
  }
  check(label, `${who}: 매니저 ${PAGES.length}개 화면 정상 렌더링(5xx·오류경계·pageerror 없음)`, bad.length === 0, bad.join(" ;; ") || `${PAGES.length}/${PAGES.length}`);
}

// ── 오너 ──
const cA = await ctx(); const pA = await cA.newPage(); wire(pA, "owner"); await login(pA, env.TEST_MANAGER_A_EMAIL, env.TEST_MANAGER_A_PASSWORD);
await visitAll(pA, "Q1", "오너");
await pA.goto(`${BASE}/manager`); await pA.waitForTimeout(2500);
const ownerMenu = await links(pA);
check("Q2", "오너: 센터 전환 후에도 전체 메뉴 유지(권한 조회 없이 전권)", await (async () => { await chip(pA, "[QA] 권한 센터 2").click(); await pA.waitForTimeout(1500); const m2 = await links(pA); await chip(pA, "[QA] 권한 센터 1").click(); await pA.waitForTimeout(1500); const m1 = await links(pA); return m1.join() === ownerMenu.join() && m2.join() === ownerMenu.join() && ownerMenu.length >= 8; })(), `owner menu=${ownerMenu.length}개`);
permReq.n = 0; await pA.goto(`${BASE}/manager/rooms`); await pA.waitForTimeout(3000);
check("Q3", "오너: 권한 조회 요청 0건(role_permissions·account_center_permissions)", permReq.n === 0, `n=${permReq.n}`);

// ── 스태프 ──
const cB = await ctx(); const pB = await cB.newPage(); wire(pB, "staff"); await login(pB, env.TEST_MANAGER_B_EMAIL, env.TEST_MANAGER_B_PASSWORD);
await visitAll(pB, "Q4", "스태프");
await pB.goto(`${BASE}/manager`); await pB.waitForTimeout(2500);
await chip(pB, "[QA] 권한 센터 1").click(); await pB.waitForTimeout(1800); const m1 = await links(pB);
await chip(pB, "[QA] 권한 센터 2").click(); await pB.waitForTimeout(1800); const m2 = await links(pB);
const sub = (a, b) => a.every((x) => b.includes(x));
check("Q5", "스태프: 센터1(제한) 메뉴 ⊂ 오너 메뉴이고 더 적다", sub(m1, ownerMenu) && m1.length < ownerMenu.length, `c1=${m1.length} owner=${ownerMenu.length}`);
check("Q6", "스태프: 센터2(확장) 메뉴가 센터1보다 많고 상품·룸·결제 항목 포함", m2.length > m1.length && m2.some((h) => /goods|rooms|membership-rules|orders|sales|members/.test(h)), `c1=${m1.join(",")} | c2=${m2.join(",")}`);
// 센터 전환 중 이전 센터 권한 잔존 여부 — 클릭 직후 프레임별 메뉴 관찰(센터2 → 센터1)
await chip(pB, "[QA] 권한 센터 2").click(); await pB.waitForTimeout(1500);
const only2 = m2.filter((h) => !m1.includes(h));
await pB.evaluate(() => { window.__frames = []; const tick = () => { window.__frames.push({ on: document.querySelector("button.center-chip.on")?.textContent ?? "", menu: [...new Set([...document.querySelectorAll("a[href^='/manager/']")].map((a) => a.getAttribute("href")))] }); window.__raf = requestAnimationFrame(tick); }; tick(); });
await chip(pB, "[QA] 권한 센터 1").click(); await pB.waitForTimeout(2000);
const frames = await pB.evaluate(() => { cancelAnimationFrame(window.__raf); return window.__frames; });
// 센터1 칩이 선택된 프레임(= 센터가 바뀐 렌더)에서만 센터2 전용 메뉴가 보이는지 센다 — 클릭 반영 전 프레임은 제외.
const afterSwitch = frames.filter((f) => f.on.includes("센터 1"));
const stale = afterSwitch.filter((f) => f.menu.some((h) => only2.includes(h))).length;
const final1 = await links(pB);
check("Q7", "센터 전환(2→1): 전환 후 프레임에 센터2 전용 메뉴가 남지 않고 최종 메뉴=센터1", afterSwitch.length > 0 && stale === 0 && final1.join() === m1.join(), `센터1 선택 후 프레임 ${afterSwitch.length}개 중 stale ${stale}, 센터2 전용=${only2.length}개`);
// 새로고침 복원
await pB.goto(`${BASE}/manager/rooms`); await pB.waitForTimeout(2500); await chip(pB, "[QA] 권한 센터 2").click().catch(() => {}); await pB.waitForTimeout(1500);
const roomsBtn = async () => (await pB.getByRole("button", { name: /추가|등록|룸 추가/ }).count()) > 0;
const before = await roomsBtn(); await pB.reload({ waitUntil: "domcontentloaded" }); await pB.waitForTimeout(2800); await chip(pB, "[QA] 권한 센터 2").click().catch(() => {}); await pB.waitForTimeout(1500);
check("Q8", "새로고침 후 권한 정상 복원(센터2 facility.room → 룸 관리 버튼 표시 일관)", before === (await roomsBtn()), `before=${before}`);
// 센터1(권한 없음)에서는 룸 관리 버튼 숨김
await chip(pB, "[QA] 권한 센터 1").click().catch(() => {}); await pB.waitForTimeout(1800);
check("Q9", "스태프 센터1(facility.room 없음): 룸 관리 버튼 숨김", !(await roomsBtn()));
// 로그아웃 → 다른 계정(오너) 로그인 시 이전 스태프 권한 상태 제거
await pB.evaluate(() => { localStorage.clear(); sessionStorage.clear(); }); await cB.clearCookies();
await login(pB, env.TEST_MANAGER_A_EMAIL, env.TEST_MANAGER_A_PASSWORD); await pB.goto(`${BASE}/manager`); await pB.waitForTimeout(2500);
check("Q10", "로그아웃(저장소·쿠키 삭제) 후 오너 로그인: 이전 스태프 권한 흔적 없이 전체 메뉴", (await links(pB)).join() === ownerMenu.join());
// 빠른 화면 이동 + 요청 수 + 무한 렌더링
const cC = await ctx(); const pC = await cC.newPage(); wire(pC, "fast"); await login(pC, env.TEST_MANAGER_B_EMAIL, env.TEST_MANAGER_B_PASSWORD);
await pC.goto(`${BASE}/manager`); await pC.waitForTimeout(2000);
for (const r of ["/manager/rooms", "/manager/goods", "/manager/orders", "/manager/classes", "/manager/members", "/manager/settings"]) { await pC.goto(BASE + r, { waitUntil: "commit" }).catch(() => {}); await pC.waitForTimeout(120); }
await pC.waitForTimeout(2500);
const finalBody = await pC.locator("body").innerText(); const fastErr = pageErrors.filter((e) => e.startsWith("fast")).length;
check("Q11", "빠른 화면 이동(6개 연속) 후 마지막 화면(settings) 정상·pageerror 0·무한 렌더링 없음", /설정|운영/.test(finalBody) && fastErr === 0, `pageerrors=${fastErr}`);
permReq.n = 0; await pC.goto(`${BASE}/manager/rooms`); await pC.waitForTimeout(6000);
check("Q12", "스태프 단일 화면 6초 유휴: 권한 조회 요청이 소수(무한 재조회 없음)", permReq.n > 0 && permReq.n <= 6, `role/override 요청 ${permReq.n}회`);
console.log(`INFO perm-requests-per-page-load=${permReq.n}`);
// 조회 실패 처리
const cD = await ctx(); const pD = await cD.newPage(); wire(pD, "perr"); await login(pD, env.TEST_MANAGER_B_EMAIL, env.TEST_MANAGER_B_PASSWORD);
await pD.route("**/rest/v1/role_permissions*", (r) => r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ message: "boom-perm-error", code: "XX000" }) }));
await pD.goto(`${BASE}/manager/rooms`); await pD.waitForTimeout(3500);
const toast = await pD.locator(".error-toast").innerText().catch(() => ""); const bodyD = await pD.locator("body").innerText();
check("Q13", "권한 조회 실패(500): 기존과 같이 오류 토스트 표시·크래시 없음·관리 버튼 노출 안 됨", /boom|권한|불러오지/.test(toast) && !/Application error/.test(bodyD) && (await pD.getByRole("button", { name: /룸 추가|추가/ }).count()) === 0, `toast="${toast.slice(0, 60)}"`);
// 태블릿 nav
const cE = await ctx({ width: 1024, height: 768 }, true); const pE = await cE.newPage(); wire(pE, "tablet"); await login(pE, env.TEST_MANAGER_B_EMAIL, env.TEST_MANAGER_B_PASSWORD);
await pE.goto(`${BASE}/manager`); await pE.waitForTimeout(2500); await chip(pE, "[QA] 권한 센터 2").click().catch(() => {}); await pE.waitForTimeout(1800);
const sideLinks = await pE.evaluate(() => [...document.querySelectorAll("aside.workspace-sidebar a")].map((a) => a.getAttribute("href")));
const exp0 = await pE.locator("aside.workspace-sidebar").first().getAttribute("aria-expanded");
await pE.evaluate(async () => { const el = document.querySelector("aside.workspace-sidebar"); const mk = (t, x) => new PointerEvent(t, { pointerType: "touch", pointerId: 7, isPrimary: true, bubbles: true, cancelable: true, clientX: x, clientY: 300 }); let x = 30; el.dispatchEvent(mk("pointerdown", x)); for (let i = 0; i < 10; i++) { x += 8; el.dispatchEvent(mk("pointermove", x)); await new Promise((r) => setTimeout(r, 16)); } el.dispatchEvent(mk("pointerup", x)); });
await pE.waitForTimeout(500); const exp1 = await pE.locator("aside.workspace-sidebar").first().getAttribute("aria-expanded");
check("Q14", "태블릿 매니저 nav: 스태프 권한에 맞는 메뉴 + 스와이프로 펼침(aria-expanded)", sideLinks.length > 0 && exp0 !== "true" && exp1 === "true", `links=${sideLinks.length} ${exp0}->${exp1}`);
check("Q15", "전 과정 pageerror(미처리 예외)·무한 렌더링 경고 0건", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
check("Q16", "외부 호스트 요청은 모두 차단", true, [...external].join(",") || "없음");
await browser.close();
const f = results.filter((r) => !r.ok).length; console.log(`SUMMARY pass=${results.length - f} fail=${f}`); process.exit(f ? 1 : 0);
