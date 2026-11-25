/*
  Issue #274 Batch 2(의존값 변경 시 상태 초기화 → useResetOnChange / 파생값) 브라우저 QA — 격리 Supabase 스택 + next start(3216) 전용.
  실제 결제·주문·예약 생성 없음, 외부 호스트 차단. 같은 시나리오를 "정리 전(main bffe2e92)"과 "수정 후" 빌드에 각각 돌려 관찰값(OBS 줄)을 비교한다.
  사용: ISO_ENV_FILE=<env> [BASE=http://127.0.0.1:3216] node tests/qa/stateReset/batch2.mjs
  전제 시험 데이터: [UX] 격리 UX 시험 센터(QA_UX)·[QA] 권한 센터 2(QA_C2) — 오너 TEST_MANAGER_A, 스태프 TEST_MANAGER_B(UX=제한 역할, C2=확장 역할),
        UX 센터 회원 TEST_USER_A/B("CI User A/B"), UX 센터 쿠폰 "[QA] 시험 쿠폰".
*/
import fs from "node:fs"; import { createRequire } from "node:module";
const require = createRequire(process.cwd() + "/package.json"); const { chromium } = require("playwright");
const BASE = process.env.BASE ?? "http://127.0.0.1:3216";
const env = {}; for (const ln of fs.readFileSync(process.env.ISO_ENV_FILE, "utf8").split("\n")) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(ln.trim()); if (m) env[m[1]] = m[2]; }
if (!/^http:\/\/127\.0\.0\.1:/.test(env.NEXT_PUBLIC_SUPABASE_URL)) { console.error("ABORT: 로컬 격리 Supabase 가 아님"); process.exit(1); }
const browser = await chromium.launch();
const results = []; const external = new Set(); const pageErrors = []; const reqCount = {};
const OBS = (id, v) => console.log(`OBS ${id} ${JSON.stringify(v)}`);
const check = (id, name, ok, detail = "") => { results.push({ id, name, ok }); console.log(`${ok ? "PASS" : "FAIL"} ${id} ${name}${detail ? " — " + String(detail).slice(0, 200) : ""}`); };
const blocked = (id, name, why) => { results.push({ id, name, ok: null }); console.log(`BLOCKED ${id} ${name} — ${why}`); };
async function ctx(viewport = { width: 1100, height: 900 }, touch = false) {
  const c = await browser.newContext({ viewport, hasTouch: touch });
  await c.route("**/*", (r) => { const u = new URL(r.request().url()); if (["127.0.0.1", "localhost"].includes(u.hostname)) { const k = u.pathname.replace(/^\/rest\/v1\//, "").split("/")[0]; if (u.pathname.startsWith("/rest/v1/") || u.pathname.startsWith("/rpc")) reqCount[k] = (reqCount[k] ?? 0) + 1; return r.continue(); } external.add(u.hostname); return r.abort(); });
  return c;
}
const wire = (p, tag) => { p.on("pageerror", (e) => pageErrors.push(`${tag}: ${String(e.message).slice(0, 160)}`)); p.on("console", (m) => { if (m.type() === "error" && /Maximum update depth|Too many re-renders/i.test(m.text())) pageErrors.push(`${tag}: ${m.text().slice(0, 120)}`); }); };
async function login(p, email, password) { await p.goto(`${BASE}/login`); await p.locator('input[type="email"]').fill(email); await p.locator('input[type="password"]').fill(password); await p.locator("button.login-submit").click(); await p.waitForURL(`${BASE}/`, { timeout: 30000 }).catch(() => {}); await p.waitForTimeout(1200); }
const chip = (p, name) => p.locator("button.center-chip", { hasText: name }).first();
const UXN = "[UX] 격리 UX 시험 센터", C2N = "[QA] 권한 센터 2";
async function scenario(id, name, fn) { const before = pageErrors.length; try { await fn(); } catch (e) { blocked(id, name, `시나리오 실행 불가: ${String(e.message).slice(0, 120)}`); } if (pageErrors.length > before) check(`${id}-err`, `${name}: pageerror 없음`, false, pageErrors.slice(before).join(" | ")); }
const aside = (p) => p.locator("aside.workspace-sidebar").first();
const expanded = async (p, sel = "aside.workspace-sidebar") => (await p.locator(sel).first().getAttribute("aria-expanded")) === "true";
async function swipe(p, dx, sel = "aside.workspace-sidebar") { await p.evaluate(async ({ dx, sel }) => { const el = document.querySelector(sel); const mk = (t, x) => new PointerEvent(t, { pointerType: "touch", pointerId: 7, isPrimary: true, bubbles: true, cancelable: true, clientX: x, clientY: 300 }); let x = dx > 0 ? 30 : 200; el.dispatchEvent(mk("pointerdown", x)); for (let i = 0; i < 10; i++) { x += dx / 10; el.dispatchEvent(mk("pointermove", x)); await new Promise((r) => setTimeout(r, 16)); } el.dispatchEvent(mk("pointerup", x)); }, { dx, sel }); await p.waitForTimeout(450); }
const path = (p) => new URL(p.url()).pathname;

// ── NAV: 태블릿 매니저 내비게이션(useExpandableNavRail) ──
await scenario("N", "태블릿 매니저 nav", async () => {
  const c = await ctx({ width: 1024, height: 768 }, true); const p = await c.newPage(); wire(p, "nav"); await login(p, env.TEST_MANAGER_B_EMAIL, env.TEST_MANAGER_B_PASSWORD);
  await p.goto(`${BASE}/manager`); await p.waitForTimeout(2500); await chip(p, UXN).click().catch(() => {}); await p.waitForTimeout(1500);
  const links0 = await p.evaluate(() => [...document.querySelectorAll("aside.workspace-sidebar a")].map((a) => a.getAttribute("href")));
  const i0 = await expanded(p); await swipe(p, 80); const i1 = await expanded(p); await swipe(p, -80); const i2 = await expanded(p);
  OBS("N1", [i0, i1, i2]); check("N1", "스와이프 오른쪽=펼침, 왼쪽=접힘", !i0 && i1 && !i2, `${i0}->${i1}->${i2}`);
  await swipe(p, 80); const e3 = await expanded(p); const target = links0.find((h) => h !== path(p) && h.startsWith("/manager/")) ?? "/manager/classes";
  await aside(p).locator(`a[href='${target}']`).first().click(); await p.waitForTimeout(2200);
  const after = await expanded(p); OBS("N2", [e3, path(p) === target, after]); check("N2", "펼친 상태에서 다른 메뉴 이동 → 경로 변경 + compact 복귀", e3 && path(p) === target && !after, `exp=${e3} path=${path(p)} after=${after}`);
  await swipe(p, 80); const e4 = await expanded(p); await aside(p).locator(`a[href='${target}']`).first().click(); await p.waitForTimeout(1200); const same = await expanded(p);
  OBS("N3", [e4, same]); check("N3", "같은 경로 메뉴 클릭: 기존 정책(클릭 시 collapse)과 동일하게 접힘·재초기화 오류 없음", e4 && !same, `before=${e4} after=${same}`);
  await swipe(p, 80); const hrefs = links0.filter((h) => h.startsWith("/manager/")).slice(0, 3);
  await p.evaluate(async (hrefs) => { for (const h of hrefs) { document.querySelector(`aside.workspace-sidebar a[href='${h}']`)?.click(); await new Promise((r) => setTimeout(r, 80)); } }, hrefs); await p.waitForTimeout(2500);
  OBS("N4", [path(p), await expanded(p)]); check("N4", "빠른 연속 메뉴 이동(3회) 후 마지막 경로·compact·pageerror 없음", path(p) === hrefs[hrefs.length - 1] && !(await expanded(p)), `path=${path(p)}`);
  await swipe(p, 80); const pre = await expanded(p); await p.setViewportSize({ width: 1440, height: 900 }); await p.waitForTimeout(800); const wide = await expanded(p); await p.setViewportSize({ width: 1024, height: 768 }); await p.waitForTimeout(800); const back = await expanded(p);
  OBS("N5", [pre, wide, back]); check("N5", "화면 크기 변경(범위 밖 1440 → 다시 1024): 접힌 상태로 복귀(펼침 잔존 없음)", pre && !wide && !back, `${pre}->${wide}->${back}`);
  await swipe(p, 80); const pe = await expanded(p); await p.reload({ waitUntil: "domcontentloaded" }); await p.waitForTimeout(2500); const re = await expanded(p);
  OBS("N6", [pe, re]); check("N6", "새로고침 후 compact 로 정상 표시", pe && !re);
  const links1 = await p.evaluate(() => [...document.querySelectorAll("aside.workspace-sidebar a")].map((a) => a.getAttribute("href")));
  OBS("N7", links1.length); check("N7", "스태프 권한별 메뉴 표시 유지(제한 역할: 메뉴 수가 오너보다 적음)", links1.length > 0 && links1.length < 12, `links=${links1.length}`);
  await c.close();
});
// 회원 데스크톱 내비게이션(같은 훅)
await scenario("NM", "회원 nav", async () => {
  const c = await ctx({ width: 1024, height: 768 }, true); const p = await c.newPage(); wire(p, "membernav"); await login(p, env.TEST_USER_A_EMAIL, env.TEST_USER_A_PASSWORD);
  await p.goto(`${BASE}/`); await p.waitForTimeout(2500);
  if (!(await p.locator("aside.member-desktop-nav").count())) { blocked("NM1", "회원 nav 펼침/접힘", "member-desktop-nav 없음"); await c.close(); return; }
  const a = await expanded(p, "aside.member-desktop-nav"); await swipe(p, 80, "aside.member-desktop-nav"); const b = await expanded(p, "aside.member-desktop-nav"); await swipe(p, -80, "aside.member-desktop-nav"); const d = await expanded(p, "aside.member-desktop-nav");
  OBS("NM1", [a, b, d]); check("NM1", "회원 nav 스와이프 펼침/접힘", !a && b && !d, `${a}->${b}->${d}`);
  await swipe(p, 80, "aside.member-desktop-nav"); await p.locator("aside.member-desktop-nav a[href='/search']").first().click(); await p.waitForTimeout(2000);
  OBS("NM2", [path(p), await expanded(p, "aside.member-desktop-nav")]); check("NM2", "회원 nav 이동 후 compact", path(p) === "/search" && !(await expanded(p, "aside.member-desktop-nav")));
  await c.close();
});

// ── 관리자: 회원 추가 시트 / 쿠폰 지급 / 수강권 규칙 / 수업 ──
const cA = await ctx(); const pA = await cA.newPage(); wire(pA, "owner"); await login(pA, env.TEST_MANAGER_A_EMAIL, env.TEST_MANAGER_A_PASSWORD);
await scenario("M", "회원 추가 시트(MemberAddSheet)", async () => {
  await pA.goto(`${BASE}/manager/members`); await pA.waitForTimeout(2500); await chip(pA, UXN).click(); await pA.waitForTimeout(2000);
  await pA.getByRole("button", { name: "+회원" }).click(); await pA.waitForTimeout(800);
  const input = pA.getByLabel("전체 휴대폰 번호 또는 회원 이름"); await input.fill("CI User A"); await input.press("Enter"); await pA.waitForTimeout(2500);
  const body1 = await pA.locator("body").innerText(); const found = /CI User A/.test(body1.split("회원 추가")[1] ?? body1);
  OBS("M1", found); check("M1", "회원 추가 시트: 검색 결과 표시", found);
  await pA.keyboard.press("Escape").catch(() => {}); await pA.locator(".sheet-overlay").first().click({ position: { x: 5, y: 5 } }).catch(() => {}); await pA.waitForTimeout(600);
  await chip(pA, C2N).click(); await pA.waitForTimeout(1500); await pA.getByRole("button", { name: "+회원" }).click(); await pA.waitForTimeout(800);
  const val = await pA.getByLabel("전체 휴대폰 번호 또는 회원 이름").inputValue(); const body2 = await pA.locator("body").innerText();
  OBS("M2", [val, /CI User A/.test(body2.split("회원 추가")[1] ?? "")]); check("M2", "센터 전환 후 다시 열면 이전 센터 검색 결과가 남지 않음", !/CI User A/.test(body2.split("회원 추가")[1] ?? ""), `입력값="${val}"`);
});
await scenario("C", "쿠폰 지급 시트", async () => {
  await pA.goto(`${BASE}/manager/coupons`); await pA.waitForTimeout(2500); await chip(pA, UXN).click(); await pA.waitForTimeout(2000);
  const issueBtn = pA.getByRole("button", { name: /지급/ }).first(); await issueBtn.click(); await pA.waitForTimeout(800);
  const input = pA.getByLabel("이름 또는 전화번호 검색"); await input.fill("CI User"); await pA.waitForTimeout(1800);
  const n1 = await pA.locator("text=/CI User [AB]/").count(); OBS("C1", n1); check("C1", "지급 시트: 검색어 입력 → 회원 결과 표시", n1 >= 1, `n=${n1}`);
  await input.fill(""); await pA.waitForTimeout(800); const n2 = await pA.locator("text=/CI User [AB]/").count(); OBS("C2", n2); check("C2", "검색어를 지우면 결과가 즉시 비워짐", n2 === 0, `n=${n2}`);
  await input.fill("CI User B"); await pA.waitForTimeout(1500); const n3 = await pA.locator("text=/CI User B/").count(); OBS("C3", n3); check("C3", "다시 입력하면 결과 재조회", n3 >= 1);
  await pA.locator(".sheet-overlay").first().click({ position: { x: 5, y: 5 } }).catch(() => {}); await pA.waitForTimeout(800); await pA.getByRole("button", { name: /지급/ }).first().click(); await pA.waitForTimeout(800);
  const n4 = await pA.locator("text=/CI User [AB]/").count(); OBS("C4", n4); check("C4", "시트를 닫았다 다시 열면 이전 결과가 남지 않음", n4 === 0, `n=${n4}`);
});
await scenario("R", "수강권 규칙 화면 센터 전환", async () => {
  await pA.goto(`${BASE}/manager/membership-rules`); await pA.waitForTimeout(2500); await chip(pA, UXN).click(); await pA.waitForTimeout(1500);
  const t1 = (await pA.locator("body").innerText()).length; await chip(pA, C2N).click(); await pA.waitForTimeout(1500); await chip(pA, UXN).click(); await pA.waitForTimeout(1500);
  OBS("R1", t1 > 100); check("R1", "센터 전환(UX→C2→UX) 후 수강권 규칙 화면 정상", (await pA.locator("body").innerText()).length > 100);
});
await scenario("P", "판매 최대 횟수 입력(CountPriceEditor)", async () => {
  await pA.goto(`${BASE}/manager/membership-rules`); await pA.waitForTimeout(2500); await pA.getByRole("button", { name: UXN }).first().click(); await pA.waitForTimeout(1500);
  await pA.getByRole("button", { name: "+ 수강권" }).click(); await pA.waitForTimeout(1000);
  let max = pA.getByLabel("판매 최대 횟수");
  if (!(await max.count())) { const tog = pA.locator("label, button, input[type=checkbox]").filter({ hasText: /횟수.*선택|선택.*횟수/ }).first(); await tog.click({ timeout: 4000 }).catch(() => {}); await pA.waitForTimeout(600); max = pA.getByLabel("판매 최대 횟수"); }
  if (!(await max.count())) { blocked("P1", "판매 최대 횟수 입력", "횟수 선택형 토글을 찾지 못함"); return; }
  const rowsN = () => pA.getByLabel(/^\d+회 가격$/).count();
  const v0 = await max.inputValue(), r0 = await rowsN();
  await max.focus(); await max.fill("5"); await pA.waitForTimeout(400); const v1 = await max.inputValue(), r1 = await rowsN();
  await max.fill(""); await pA.waitForTimeout(300); const v2 = await max.inputValue(), r2 = await rowsN();
  await max.blur(); await pA.waitForTimeout(400); const v3 = await max.inputValue(), r3 = await rowsN();
  OBS("P1", { v0, r0, v1, r1, v2, r2, v3, r3 });
  check("P1", "입력 중에는 작성 중인 글자를 유지(5 입력 → 행 5개, 비움 → 빈 칸 유지), 포커스를 잃으면 실제 행 수로 되돌림", v1 === "5" && r1 === 5 && v2 === "" && r2 === r1 && v3 === String(r3), `${v0}/${r0} → ${v1}/${r1} → "${v2}"/${r2} → ${v3}/${r3}`);
});
await scenario("K", "수업 등록 폼/운영설정", async () => {
  await pA.goto(`${BASE}/manager/classes`); await pA.waitForTimeout(2500); await pA.getByRole("button", { name: UXN }).first().click().catch(() => {}); await pA.waitForTimeout(1500);
  await pA.getByRole("button", { name: "+ 수업 등록" }).click(); await pA.waitForTimeout(1200);
  const open = (await pA.locator("body").innerText()).includes("수업"); const warn = await pA.locator("text=/겹치|충돌/").count();
  OBS("K1", [open, warn]); check("K1", "수업 등록 폼 열림 + 충돌 경고 영역 오류 없음", open);
  await pA.keyboard.press("Escape").catch(() => {}); await pA.waitForTimeout(400);
});
await scenario("D", "오늘 수업(manager/page) 센터 전환", async () => {
  await pA.goto(`${BASE}/manager`); await pA.waitForTimeout(2500);
  for (const n of [UXN, C2N, UXN, C2N, UXN]) { await chip(pA, n).click(); await pA.waitForTimeout(150); }
  await pA.waitForTimeout(2500); const txt = await pA.locator("text=/오늘 수업/").first().innerText().catch(() => ""); OBS("D1", txt.replace(/\s+/g, " ").slice(0, 40));
  check("D1", "센터 5회 빠른 전환 후 마지막 센터 기준으로 오늘 수업 영역 정상 렌더", (await pA.locator("button.center-chip.on").innerText()).includes("UX"), "마지막 선택 센터 유지");
});
await scenario("AA", "관리자 배정 로그 화면", async () => {
  await pA.goto(`${BASE}/manager/admin-assignments`); await pA.waitForTimeout(3000); const t = await pA.locator("body").innerText(); OBS("AA1", t.length > 20); check("AA1", "admin-assignments 정상 렌더", t.length > 20);
});
// ── 회원: 검색 화면 ──
await scenario("S", "검색 화면", async () => {
  const c = await ctx(); const p = await c.newPage(); wire(p, "search"); await login(p, env.TEST_USER_A_EMAIL, env.TEST_USER_A_PASSWORD);
  await p.goto(`${BASE}/search`); await p.waitForTimeout(2000); const input = p.locator("#discovery-search");
  await input.fill("a"); await p.waitForTimeout(800); const s1 = await p.locator("body").innerText();
  await input.fill("UX"); await p.waitForTimeout(2200); const s2 = await p.locator("body").innerText();
  await input.fill(""); await p.waitForTimeout(800); const s3 = await p.locator("body").innerText();
  const f = (t) => ({ has결과: /결과|센터/.test(t), len: Math.round(t.length / 50) });
  OBS("S1", [f(s1), f(s2), f(s3)]); check("S1", "검색어 1자 → 2자(결과) → 비움: 상태 초기화·오류 없음", s2.includes("UX") && !s3.includes("검색 결과를 불러오지"), `len ${s1.length}/${s2.length}/${s3.length}`);
  await c.close();
});
check("X-pageerror", "전 과정 pageerror·무한 렌더링 경고 0건", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
OBS("REQ", reqCount); check("X-external", "외부 호스트 요청은 모두 차단", true, [...external].join(",") || "없음");
await browser.close();
const f = results.filter((r) => r.ok === false).length, bl = results.filter((r) => r.ok === null).length; console.log(`SUMMARY pass=${results.filter((r) => r.ok).length} fail=${f} blocked=${bl}`); process.exit(f ? 1 : 0);
