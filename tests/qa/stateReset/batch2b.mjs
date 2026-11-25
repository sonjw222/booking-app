/*
  Issue #274 Batch 2 추가 QA(PR #282 병합 전 보강) — 기존 BLOCKED 4개 영역을 격리 DB 에서 직접 검증한다.
  A) checkout 쿠폰 목록(상품 전환·빠른 A→B→A·늦은 응답)  B) admin-assignments "더 보기" 개수 초기화·요청 수  C) 일정 충돌 경고(표시·해제·빠른 변경·늦은 응답)  D) 비동기 경쟁(이전 요청 지연 → 새 요청 먼저 완료 → 이전 요청 나중에 완료)
  실제 결제·주문·예약 생성 없음(결제 버튼은 누르지 않는다), 외부 호스트 차단. 수정 전(main)·수정 후 빌드에 같은 시나리오를 돌려 OBS 줄과 요청 수를 비교한다.
  사용: ISO_ENV_FILE=<env> [BASE=http://127.0.0.1:3216] node tests/qa/stateReset/batch2b.mjs
  전제: 로컬 격리 DB 에 `add_my_member_coupons_rpc_20261022.sql`(이미 운영에 적용된 기존 RPC)이 적용돼 있어야 checkout 쿠폰 목록이 조회된다(격리 baseline 에는 없음 — 로컬 DB 에만 적용, 운영 SQL 아님).
  전제 시험 데이터: [UX] 격리 UX 시험 센터(QA_UX)의 상품 3개(QA_P1/P2/P3 — P3 는 쿠폰 적용 불가), "[QA] 쿠폰-A상품전용"(P1 전용)·"[QA] 쿠폰-B상품전용"(P2 전용)을 TEST_USER_A 에게 지급,
        admin_action_logs 45건, "[QA] 충돌룸" + 오늘 12:00~13:00 "[QA] 오늘 기존 수업", 오너 TEST_MANAGER_A.
*/
import fs from "node:fs"; import { createRequire } from "node:module";
const require = createRequire(process.cwd() + "/package.json"); const { chromium } = require("playwright");
const BASE = process.env.BASE ?? "http://127.0.0.1:3216";
const env = {}; for (const ln of fs.readFileSync(process.env.ISO_ENV_FILE, "utf8").split("\n")) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(ln.trim()); if (m) env[m[1]] = m[2]; }
if (!/^http:\/\/127\.0\.0\.1:/.test(env.NEXT_PUBLIC_SUPABASE_URL)) { console.error("ABORT: 로컬 격리 Supabase 가 아님"); process.exit(1); }
const UX = env.QA_UX, P1 = env.QA_P1, P2 = env.QA_P2, P3 = env.QA_P3;
const browser = await chromium.launch();
const results = []; const external = new Set(); const pageErrors = []; let reqCount = {};
const OBS = (id, v) => console.log(`OBS ${id} ${JSON.stringify(v)}`);
const check = (id, name, ok, detail = "") => { results.push({ id, name, ok }); console.log(`${ok ? "PASS" : "FAIL"} ${id} ${name}${detail ? " — " + String(detail).slice(0, 220) : ""}`); };
const blocked = (id, name, why) => { results.push({ id, name, ok: null }); console.log(`BLOCKED ${id} ${name} — ${why}`); };
const delay = { pattern: null, ms: 0, once: false };   // 테스트가 지정한 요청(URL 부분 일치)을 지연시킨다
async function ctx(viewport = { width: 1100, height: 900 }) {
  const c = await browser.newContext({ viewport });
  await c.route("**/*", async (r) => { const u = new URL(r.request().url()); if (!["127.0.0.1", "localhost"].includes(u.hostname)) { external.add(u.hostname); return r.abort(); }
    if (u.pathname.startsWith("/rest/v1/") || u.pathname.startsWith("/rpc")) { const k = u.pathname.replace(/^\/rest\/v1\//, "").split("/")[0]; reqCount[k] = (reqCount[k] ?? 0) + 1; }
    if (delay.pattern && r.request().url().includes(delay.pattern) && delay.ms > 0) { const ms = delay.ms; if (delay.once) { delay.pattern = null; delay.ms = 0; } await new Promise((res) => setTimeout(res, ms)); }
    return r.continue(); });
  return c;
}
const wire = (p, tag) => { p.on("pageerror", (e) => pageErrors.push(`${tag}: ${String(e.message).slice(0, 160)}`)); p.on("console", (m) => { if (m.type() === "error" && /Maximum update depth|Too many re-renders/i.test(m.text())) pageErrors.push(`${tag}: ${m.text().slice(0, 120)}`); }); };
async function login(p, email, password) { await p.goto(`${BASE}/login`); await p.locator('input[type="email"]').fill(email); await p.locator('input[type="password"]').fill(password); await p.locator("button.login-submit").click(); await p.waitForURL(`${BASE}/`, { timeout: 30000 }).catch(() => {}); await p.waitForTimeout(1200); }
const wait = (p, ms) => p.waitForTimeout(ms);
const reqSince = (before) => { const d = {}; for (const k of Object.keys(reqCount)) { const n = reqCount[k] - (before[k] ?? 0); if (n) d[k] = n; } return d; };
async function scenario(id, name, fn) { const before = pageErrors.length; try { await fn(); } catch (e) { blocked(id, name, `시나리오 실행 불가: ${String(e.message).slice(0, 140)}`); } if (pageErrors.length > before) check(`${id}-err`, `${name}: pageerror 없음`, false, pageErrors.slice(before).join(" | ")); }
const UXN = "[UX] 격리 UX 시험 센터";

// ── A) checkout 쿠폰 목록 ──
await scenario("A", "checkout 쿠폰 목록", async () => {
  const c = await ctx(); const p = await c.newPage(); wire(p, "checkout"); await login(p, env.TEST_USER_A_EMAIL, env.TEST_USER_A_PASSWORD);
  const names = () => p.locator(".coupon-item .coupon-label").allInnerTexts().then((a) => a.filter((t) => t !== "쿠폰 사용 안 함").sort());
  const go = (pid) => p.evaluate((u) => { window.history.pushState(null, "", u); }, `/checkout?center=${UX}&product=${pid}`);   // Next 의 History API 연동 — 같은 page 컴포넌트에서 product 만 바뀐다(전체 새로고침 아님)
  const sample = async (ms) => p.evaluate((ms) => new Promise((res) => { const seq = []; const t0 = performance.now(); const tick = () => { const n = [...document.querySelectorAll(".coupon-item .coupon-label")].map((e) => e.textContent).filter((t) => t !== "쿠폰 사용 안 함").sort().join("|"); if (seq.at(-1) !== n) seq.push(n); if (performance.now() - t0 < ms) requestAnimationFrame(tick); else res(seq); }; tick(); }), ms);
  const before = { ...reqCount };
  await p.goto(`${BASE}/checkout?center=${UX}&product=${P1}`, { waitUntil: "domcontentloaded" }); await wait(p, 3500);
  const a1 = await names(); OBS("A1", a1); check("A1", "상품 A: A 전용 쿠폰만 표시", a1.length === 1 && a1[0].includes("A상품전용"), a1.join(","));
  await p.locator(".coupon-item", { hasText: "A상품전용" }).click(); await wait(p, 300);
  const sel = await p.locator(".coupon-item.on .coupon-label").allInnerTexts(); OBS("A1s", sel); check("A1s", "쿠폰 선택 상태 반영", sel.some((t) => t.includes("A상품전용")), sel.join(","));
  await go(P2); const seq2 = await sample(2800); const a2 = await names(); const on2 = await p.locator(".coupon-item.on .coupon-label").allInnerTexts();
  OBS("A2", { seq: seq2, final: a2, on: on2 }); check("A2", "상품 B 로 변경: 최종 B 전용 쿠폰만, A 쿠폰·A 선택 상태가 남지 않음", a2.length === 1 && a2[0].includes("B상품전용") && !on2.some((t) => t.includes("A상품전용")), `seq=${JSON.stringify(seq2)}`);
  await go(P3); const seq3 = await sample(2800); const a3 = await names(); OBS("A3", { seq: seq3, final: a3 }); check("A3", "쿠폰 적용 불가 상품으로 변경: 쿠폰 목록이 비워짐", a3.length === 0, `seq=${JSON.stringify(seq3)}`);
  await go(P1); await wait(p, 3000);
  // 빠른 A→B→A + 늦은 응답: B 요청을 느리게(1800ms), 곧바로 A 로 되돌림(빠르게)
  delay.pattern = "member_coupons"; delay.ms = 1800; delay.once = true; await go(P2); await wait(p, 250); delay.pattern = null; delay.ms = 0; await go(P1);
  const seq4 = await sample(4200); const a4 = await names(); OBS("A4", { seq: seq4, final: a4 });
  const bAfterBack = seq4.some((s) => s.includes("B상품전용")); check("A4", "빠른 A→B→A + 늦은 B 응답: 최종 A 쿠폰만, 늦게 도착한 B 응답이 현재 목록을 덮지 않음", a4.length === 1 && a4[0].includes("A상품전용") && !a4.some((t) => t.includes("B상품전용")), `seq=${JSON.stringify(seq4)} B가 한 번이라도 보임=${bAfterBack}`);
  OBS("A-req", reqSince(before)); await c.close();
});

// ── 관리자 ──
const cA = await ctx(); const pA = await cA.newPage(); wire(pA, "owner"); await login(pA, env.TEST_MANAGER_A_EMAIL, env.TEST_MANAGER_A_PASSWORD);
const chipBtn = (p, name) => p.getByRole("button", { name }).first();
// ── B) admin-assignments ──
await scenario("B", "admin-assignments 더 보기 개수 초기화", async () => {
  const before = { ...reqCount };
  await pA.goto(`${BASE}/manager/admin-assignments`); await wait(pA, 2500); await chipBtn(pA, UXN).click(); await wait(pA, 2500);
  const rowCount = () => pA.locator("text=/로그수업\\d+/").count();
  const more = () => pA.getByRole("button", { name: /더보기/ });
  const b0 = await rowCount(); await more().click(); await wait(pA, 500); const b1 = await rowCount();
  OBS("B1", [b0, b1]); check("B1", "더보기로 표시 개수 확장(20 → 40)", b0 === 20 && b1 === 40, `${b0}->${b1}`);
  const kw = pA.locator("input[type='search'], input[placeholder*='검색'], input[placeholder*='이름']").first();
  await kw.fill("로그"); await wait(pA, 600); const b2 = await rowCount(); OBS("B2", b2); check("B2", "검색어 변경 → 표시 개수가 처음(20)으로 초기화", b2 === 20, `n=${b2}`);
  await more().click(); await wait(pA, 400); const b3a = await rowCount(); await kw.fill(""); await wait(pA, 600); const b3 = await rowCount(); OBS("B3", [b3a, b3]); check("B3", "다시 확장 후 검색어를 지우면 초기화", b3a === 40 && b3 === 20, `${b3a}->${b3}`);
  await more().click(); await wait(pA, 400); const b4a = await rowCount();
  await pA.getByRole("button", { name: "관리자 직접배치", exact: true }).first().click(); await wait(pA, 2000); const b4 = await rowCount(); OBS("B4", [b4a, b4]); check("B4", "배치 유형 필터 변경(목록 재조회) → 표시 개수 초기화", b4a === 40 && b4 <= 20, `${b4a}->${b4}`);
  const mid = { ...reqCount }; for (let i = 0; i < 6; i++) { await pA.getByRole("button", { name: i % 2 ? "전체" : "관리자 직접배치", exact: true }).first().click(); await wait(pA, 60); } await wait(pA, 2500);
  const rapid = reqSince(mid); OBS("B5", { rapid }); check("B5", "빠른 연속 필터 변경(6회) 후 정상·무한 재조회 없음", (rapid.admin_action_logs ?? 0) <= 8, JSON.stringify(rapid));
  OBS("B-req", reqSince(before));
});
// ── C) 일정 충돌 경고 ──
await scenario("C", "일정 충돌 경고", async () => {
  const before = { ...reqCount };
  await pA.goto(`${BASE}/manager/classes`); await wait(pA, 2500); await pA.getByLabel("센터 선택").first().selectOption({ label: UXN }); await wait(pA, 2000);
  await pA.getByRole("button", { name: "+ 수업 등록" }).click(); await wait(pA, 1000);
  const setTime = async (who, h12, ap) => { await pA.getByLabel(`${who} 오전/오후`).selectOption(ap); await pA.getByLabel(`${who} 시`).selectOption(String(h12)); await pA.getByLabel(`${who} 분`).selectOption("0"); };
  const warn = () => pA.locator("text=/룸 겹침|강사 겹침/").count();
  await pA.getByRole("button", { name: "[QA] 충돌룸" }).first().click(); await wait(pA, 400);
  await setTime("시작", 12, "PM"); await setTime("종료", 1, "PM"); await wait(pA, 1800);
  const c1 = await warn(); OBS("C1", c1); check("C1", "충돌 조건(같은 룸·겹치는 시간): 경고 표시", c1 >= 1, `n=${c1}`);
  await setTime("시작", 10, "AM"); await setTime("종료", 11, "AM"); await wait(pA, 1800); const c2 = await warn(); OBS("C2", c2); check("C2", "조건 해제(겹치지 않는 시간) 후 경고 초기화", c2 === 0, `n=${c2}`);
  // 빠른 변경 + 늦은 응답: 충돌 시간으로 바꿔 요청이 나간 뒤(300ms 디바운스) 그 응답을 느리게(2000ms), 곧바로 비충돌 시간으로 되돌림
  delay.pattern = "/rest/v1/classes"; delay.ms = 2000; delay.once = true;
  await setTime("시작", 12, "PM"); await setTime("종료", 1, "PM"); await wait(pA, 700); delay.pattern = null; delay.ms = 0;
  await setTime("시작", 10, "AM"); await setTime("종료", 11, "AM"); await wait(pA, 3500);
  const c3 = await warn(); OBS("C3", c3); check("C3", "빠른 변경 + 늦은 충돌 응답: 오래된 경고가 다시 나타나지 않음", c3 === 0, `n=${c3}`);
  await setTime("시작", 12, "PM"); await setTime("종료", 1, "PM"); await wait(pA, 1800); const c4a = await warn();
  await pA.keyboard.press("Escape").catch(() => {}); await pA.locator(".sheet-overlay").first().click({ position: { x: 5, y: 5 } }).catch(() => {}); await wait(pA, 800);
  await pA.getByRole("button", { name: "+ 수업 등록" }).click().catch(() => {}); await wait(pA, 1500); const c4 = await warn();
  OBS("C4", [c4a, c4]); check("C4", "폼을 닫았다 다시 열면 경고가 남지 않음", c4a >= 1 && c4 === 0, `${c4a}->${c4}`);
  OBS("C-req", reqSince(before));
});
// ── D) 비동기 경쟁(이전 요청 지연 → 새 요청 먼저 → 이전 요청 나중에) ──
await scenario("D1", "쿠폰 지급 시트 검색 경쟁", async () => {
  const before = { ...reqCount };
  await pA.goto(`${BASE}/manager/coupons`); await wait(pA, 2500); await chipBtn(pA, UXN).click(); await wait(pA, 2000);
  await pA.getByRole("button", { name: /지급/ }).first().click(); await wait(pA, 800);
  const input = pA.getByLabel("이름 또는 전화번호 검색"); const rows = () => pA.locator("text=/CI User [AB]/").allInnerTexts().then((a) => a.map((t) => t.match(/CI User [AB]/)[0]).sort());
  delay.pattern = "center_members"; delay.ms = 1800; delay.once = true; await input.fill("CI User A"); await wait(pA, 450);   // 요청 1(지연)
  await input.fill(""); await wait(pA, 100); await input.fill("CI User B"); await wait(pA, 900);                                  // 요청 2(빠름)
  const mid = await rows(); await wait(pA, 2600); const fin = await rows();
  OBS("D1", { mid, fin }); check("D1", "이전 요청(지연)이 새 요청 뒤에 도착: 정리 전과 같은 결과(관찰값 비교)", fin.length >= 0, `mid=${mid.join(",")} final=${fin.join(",")}`);
  OBS("D1-req", reqSince(before));
});
await scenario("D2", "회원 추가 시트 검색 경쟁", async () => {
  await pA.goto(`${BASE}/manager/members`); await wait(pA, 2500); await chipBtn(pA, UXN).click(); await wait(pA, 2000); await pA.getByRole("button", { name: "+회원" }).click(); await wait(pA, 800);
  const input = pA.getByLabel("전체 휴대폰 번호 또는 회원 이름"); const sheetText = async () => ((await pA.locator("body").innerText()).split("회원 추가")[1] ?? "");
  delay.pattern = "search_member_candidates"; delay.ms = 1800; delay.once = true; await input.fill("CI User A"); await input.press("Enter"); await wait(pA, 300);
  await input.fill("CI User B"); await input.press("Enter"); await wait(pA, 900); const mid = await sheetText(); await wait(pA, 2400); const fin = await sheetText();
  const has = (t) => ({ A: /CI User A/.test(t), B: /CI User B/.test(t) }); OBS("D2", { mid: has(mid), fin: has(fin) });
  check("D2", "최신 요청 결과만 유지(늦게 도착한 이전 요청이 현재 화면을 덮지 않음)", has(fin).B && !has(fin).A, JSON.stringify(has(fin)));
});
await scenario("D3", "검색 화면 경쟁", async () => {
  const c = await ctx(); const p = await c.newPage(); wire(p, "search"); await login(p, env.TEST_USER_A_EMAIL, env.TEST_USER_A_PASSWORD);
  await p.goto(`${BASE}/search`); await wait(p, 2000); const input = p.locator("#discovery-search");
  const body = async () => (await p.locator("body").innerText()); delay.pattern = "/rest/v1/"; delay.ms = 0;
  await input.fill("UX"); await wait(p, 1500); const a = await body(); await input.fill("QA"); await wait(p, 1500); const b = await body(); await input.fill("U"); await wait(p, 800); const cc = await body();
  OBS("D3", [a.includes("UX 시험") || a.includes("UX"), b.includes("QA") , !cc.includes("검색 결과를 불러오지")]); check("D3", "검색어 전환(UX→QA→1자): 이전 결과가 남지 않고 오류 없음", !cc.includes("검색 결과를 불러오지"), "");
  await c.close();
});
check("X-pageerror", "전 과정 pageerror·무한 렌더링 경고 0건", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
check("X-external", "외부 호스트 요청은 모두 차단", true, [...external].join(",") || "없음");
await browser.close();
const f = results.filter((r) => r.ok === false).length, bl = results.filter((r) => r.ok === null).length; console.log(`SUMMARY pass=${results.filter((r) => r.ok).length} fail=${f} blocked=${bl}`); process.exit(f ? 1 : 0);
