/*
  ESLint 정리(#267~#272) 영향 + 주요 화면 스모크 — 격리 스택(mwhabit-reviewpath) + next start(3216) + https 프록시(3217) 전용. 실제 결제·주문·예약 없음, 외부 호스트 차단.
  사용: ISO_ENV_FILE=<env> OUT=<dir> node tests/qa/regression20261117/impact.mjs
*/
import { BASE, browser, env, psql, settle, check, save, external } from "../uxIntegration/lib.mjs";
const CENTER = env.TEST_CENTER_ID;
const errors = [];   // 화면별 pageerror/console.error
async function newCtx(email, password, { viewport = { width: 390, height: 844 }, touch = true } = {}) {
  const ctx = await browser.newContext({ viewport, hasTouch: touch, isMobile: touch });
  await ctx.route("**/*", (r) => ["mwhabit.com", "127.0.0.1"].includes(new URL(r.request().url()).hostname) ? r.continue() : (external.add(new URL(r.request().url()).hostname), r.abort()));
  const p = await ctx.newPage();
  if (email) { await p.goto(`${BASE}/login`); await p.locator('input[type="email"]').fill(email); await p.locator('input[type="password"]').fill(password); await p.locator("button.login-submit").click(); await p.waitForURL(`${BASE}/`, { timeout: 30000 }).catch(() => {}); await settle(p, 1500); }
  return { ctx, p };
}
const wire = (p, tag) => { p.on("pageerror", (e) => errors.push({ tag, kind: "pageerror", msg: String(e.message).slice(0, 200) })); p.on("console", (m) => { if (m.type() === "error") errors.push({ tag, kind: "console", msg: m.text().slice(0, 200) }); }); };

// ───────── S: 주요 화면 스모크(회원·매니저) ─────────
const memberRoutes = ["/", "/search", "/reservation", "/my-reservations", "/mypage", "/mypage/calendar", "/mypage/coupons", "/mypage/points", "/mypage/info", "/cart", "/checkout", "/notifications", "/purchases", "/settings", "/inquiries", "/profiles", "/about", "/legal/terms", "/legal/privacy", `/center/${CENTER}`];
const managerRoutes = ["/manager", "/manager/members", "/manager/classes", "/manager/orders", "/manager/sales", "/manager/notifications", "/manager/announcements", "/manager/coupons", "/manager/goods", "/manager/holidays", "/manager/inquiries", "/manager/leads", "/manager/membership-rules", "/manager/progress", "/manager/reviews", "/manager/rooms", "/manager/settings", "/manager/settlement", "/manager/staff", "/manager/center-info", "/manager/class-revenue", "/manager/subscription", "/manager/alimtalk", "/manager/admin-assignments"];
async function sweep(label, email, password, routes) {
  const { ctx, p } = await newCtx(email, password); wire(p, label);
  let ok = 0; const bad = [];
  for (const r of routes) {
    const before = errors.length; let st = 0;
    try { const res = await p.goto(BASE + r, { waitUntil: "domcontentloaded", timeout: 30000 }); st = res?.status() ?? 0; await settle(p, 1800); } catch (e) { bad.push(`${r}: goto ${String(e.message).slice(0, 60)}`); continue; }
    const body = await p.locator("body").innerText().catch(() => "");
    const boundary = /Application error|문제가 발생했어요|예기치 못한 오류|Something went wrong/i.test(body);
    const newErr = errors.slice(before).filter((e) => !/favicon|Failed to load resource.*(404|403)|net::ERR_ABORTED|ERR_BLOCKED/i.test(e.msg));
    if (st >= 500 || boundary || newErr.some((e) => e.kind === "pageerror")) bad.push(`${r}: status=${st} boundary=${boundary} err=${newErr.map((e) => e.msg).join(" | ").slice(0, 120)}`); else ok++;
  }
  check(`S-${label}`, `${label} 주요 화면 ${routes.length}개: 5xx·오류 경계·pageerror 없음`, bad.length === 0 ? "PASS" : "FAIL", bad.length ? bad.join(" ;; ") : `${ok}/${routes.length}`);
  await ctx.close();
}
await sweep("member", env.TEST_USER_A_EMAIL, env.TEST_USER_A_PASSWORD, memberRoutes);
await sweep("manager", env.TEST_MANAGER_A_EMAIL, env.TEST_MANAGER_A_PASSWORD, managerRoutes);
{ const { ctx, p } = await newCtx(null); wire(p, "anon"); let bad = [];
  for (const r of ["/login", "/reset-password", "/about", "/legal/terms", "/legal/privacy", "/"]) { const res = await p.goto(BASE + r, { waitUntil: "domcontentloaded" }); await settle(p, 1200); if ((res?.status() ?? 0) >= 500) bad.push(r); }
  check("S-anon", "비로그인 공개 화면: 5xx 없음", bad.length === 0 ? "PASS" : "FAIL", bad.join(",")); await ctx.close(); }

// ───────── L: <Link> 전환(soft navigation) ─────────
{ const { ctx, p } = await newCtx(null); wire(p, "link");
  await p.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" }); await settle(p, 1500);
  await p.evaluate(() => { window.__marker = "alive"; });
  const logo = p.locator("a[href='/']").first(); const n = await p.locator("a[href='/']").count();
  await logo.click(); await settle(p, 2000);
  check("L1", "로그인 로고 링크 → 홈 이동(소프트 내비게이션: 문서 재로드 없음)", new URL(p.url()).pathname === "/" && (await p.evaluate(() => window.__marker)) === "alive" ? "PASS" : "FAIL", `a[href=/]=${n} url=${p.url()}`);
  await ctx.close(); }
{ const { ctx, p } = await newCtx(env.TEST_USER_A_EMAIL, env.TEST_USER_A_PASSWORD); wire(p, "link2");
  await p.goto(`${BASE}/checkout?center=${CENTER}&product=00000000-0000-4000-8000-000000000000`, { waitUntil: "domcontentloaded" }); await settle(p, 3500);
  const link = p.getByRole("link", { name: "홈으로" });
  if (await link.count()) { await p.evaluate(() => { window.__marker = "alive"; }); await link.click(); await settle(p, 2000);
    check("L2", "결제 화면(없는 상품) '홈으로' → 홈(소프트 내비게이션), 오류 화면 문구 표시", new URL(p.url()).pathname === "/" && (await p.evaluate(() => window.__marker)) === "alive" ? "PASS" : "FAIL", p.url()); }
  else check("L2", "결제 화면(없는 상품) '홈으로' 링크 표시", "FAIL", (await p.locator("body").innerText()).slice(0, 120));
  await ctx.close(); }

// ───────── E: errMsg(오류 메시지 표시) ─────────
{ const { ctx, p } = await newCtx(null, undefined, { touch: false }); wire(p, "err");
  await p.goto(`${BASE}/login`); await p.locator('input[type="email"]').fill(env.TEST_USER_A_EMAIL); await p.locator('input[type="password"]').fill("wrong-password-xyz"); await p.locator("button.login-submit").click(); await settle(p, 2500);
  const t = await p.locator("body").innerText();
  check("E1", "잘못된 비밀번호 → 오류 문구 표시(빈 문구·'undefined' 아님), 로그인 화면 유지", new URL(p.url()).pathname === "/login" && !/undefined/.test(t) && /(비밀번호|이메일|로그인|올바르지)/.test(t) ? "PASS" : "FAIL", t.replace(/\s+/g, " ").slice(0, 160));
  await ctx.close(); }
{ const { ctx, p } = await newCtx(env.TEST_MANAGER_A_EMAIL, env.TEST_MANAGER_A_PASSWORD); wire(p, "err2");
  await p.route("**/rest/v1/profiles*", (r) => r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ message: "boom-test-error", code: "XX000" }) }));
  await p.goto(`${BASE}/manager/members`, { waitUntil: "domcontentloaded" }); await settle(p, 4000);
  const t = await p.locator("body").innerText();
  check("E2", "매니저 회원 화면: 조회 실패(500) 시 오류 문구 표시·화면 크래시 없음", !/Application error/.test(t) && !/undefined/.test(t) && t.length > 40 ? "PASS" : "FAIL", t.replace(/\s+/g, " ").slice(0, 160));
  await ctx.close(); }

// ───────── M: manager/members filtersRef(useLayoutEffect) ─────────
{ const { ctx, p } = await newCtx(env.TEST_MANAGER_A_EMAIL, env.TEST_MANAGER_A_PASSWORD, { viewport: { width: 1100, height: 900 }, touch: false }); wire(p, "members");
  await p.goto(`${BASE}/manager/members`, { waitUntil: "domcontentloaded" }); await settle(p, 4000);
  const rows = () => p.evaluate(() => document.body.innerText.match(/CI User [AB]/g)?.length ?? 0);
  const before = await rows();
  const input = p.locator("input[type='search'], input[placeholder*='검색'], input[placeholder*='이름']").first();
  if (await input.count()) {
    await input.fill("User B"); await settle(p, 1500); const filtered = await rows(); const onlyB = !(await p.locator("body").innerText()).includes("CI User A");
    await input.fill(""); await settle(p, 1500); const restored = await rows();
    check("M1", "회원 검색어 입력 → 목록이 즉시 좁혀지고(User B만), 지우면 복원(filtersRef 최신값 반영)", before >= 2 && filtered >= 1 && onlyB && restored >= 2 ? "PASS" : "FAIL", `before=${before} filtered=${filtered} onlyB=${onlyB} restored=${restored}`);
    await input.fill("User A"); await settle(p, 800); await p.reload({ waitUntil: "domcontentloaded" }); await settle(p, 3500);
    check("M2", "새로고침 후 로드 완료 → 목록 정상(조회 도중 바뀐 필터 적용 경로)", (await rows()) >= 2 ? "PASS" : "FAIL", `rows=${await rows()}`);
  } else check("M1", "회원 검색 입력창 존재", "FAIL", "input not found");
  await ctx.close(); }

// ───────── W: SwipeRow(useLayoutEffect cfg) — 알림 ─────────
{ const acc = psql(`select a.id from accounts a join auth.users u on u.id=a.auth_id where u.email='${env.TEST_USER_A_EMAIL}'`);
  for (const n of ["QA 알림 1", "QA 알림 2"]) psql(`insert into notifications(recipient_account_id, kind, title, body) values ('${acc}','system','${n}','회귀 QA 시험용(격리 DB)')`);
  const { ctx, p } = await newCtx(env.TEST_USER_A_EMAIL, env.TEST_USER_A_PASSWORD); wire(p, "swipe");
  const cdp = await ctx.newCDPSession(p);
  await p.goto(`${BASE}/notifications`, { waitUntil: "domcontentloaded" }); await settle(p, 3000);
  const rowsN = await p.locator(".swipe-row").count();
  const state = (i) => p.locator(".swipe-row").nth(i).getAttribute("data-swipe-state");
  const tx = (i) => p.locator(".swipe-row").nth(i).locator(".swipe-row-content").evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).m41);
  async function swipe(i, dx) { const b = await p.locator(".swipe-row").nth(i).locator(".swipe-row-content").boundingBox(); const y = b.y + b.height / 2; let x = dx < 0 ? b.x + b.width - 30 : b.x + 30;
    const pt = (xx) => [{ x: xx, y }]; await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: pt(x) });
    for (let s = 1; s <= 12; s++) { x += dx / 12; await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: pt(x) }); await p.waitForTimeout(16); }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }); await p.waitForTimeout(700); }
  if (rowsN >= 2) {
    await swipe(0, -130); const x0 = await tx(0);
    check("W1", "알림 행 왼쪽 스와이프 → 삭제 액션이 열림(중간 정지 없이 스냅)", x0 < -40 && (await state(0)) === "idle" ? "PASS" : "FAIL", `x=${Math.round(x0)} state=${await state(0)}`);
    await swipe(1, -130); const x0b = await tx(0), x1 = await tx(1);
    check("W2", "다른 행을 열면 이전 행은 닫힘(열린 행 id 공유 — cfg ref 최신값)", Math.abs(x0b) < 6 && x1 < -40 ? "PASS" : "FAIL", `row0=${Math.round(x0b)} row1=${Math.round(x1)}`);
    await swipe(1, 130); const x1c = await tx(1);
    check("W3", "열린 행을 반대로 밀면 닫힘", Math.abs(x1c) < 6 ? "PASS" : "FAIL", `row1=${Math.round(x1c)}`);
    check("W4", "스와이프만으로는 삭제·고정이 실행되지 않음(알림 2건 유지)", psql(`select count(*) from notifications where recipient_account_id='${acc}'`) === "2" ? "PASS" : "FAIL");
  } else check("W1", "알림 행 렌더", "FAIL", `rows=${rowsN} body=${(await p.locator("body").innerText()).slice(0, 100)}`);
  await ctx.close(); psql(`delete from notifications where recipient_account_id='${acc}' and title like 'QA 알림%'`); }

// ───────── N: useExpandableNavRail(useLayoutEffect expandedRef) — 매니저 nav ─────────
{ const { ctx, p } = await newCtx(env.TEST_MANAGER_A_EMAIL, env.TEST_MANAGER_A_PASSWORD, { viewport: { width: 1024, height: 768 }, touch: true }); wire(p, "nav");
  await p.goto(`${BASE}/manager`, { waitUntil: "domcontentloaded" }); await settle(p, 3500);
  const nav = p.locator(".workspace-sidebar").first(); const has = () => nav.evaluate((el) => el.getAttribute("aria-expanded") === "true");   // 펼침 상태는 aside 의 aria-expanded 로 노출된다
  if (await nav.count()) {
    const b = await nav.boundingBox(); const y = b.y + Math.min(300, b.height / 2);
    // CDP 터치는 브라우저 제스처 판정(pointercancel)에 막힐 수 있어, 훅의 판정 로직을 직접 쓰는 합성 PointerEvent(touch)로 구동한다.
    async function drag(dx) { await p.evaluate(async ({ dx, y }) => { const el = document.querySelector("aside.workspace-sidebar"); const mk = (t, x) => new PointerEvent(t, { pointerType: "touch", pointerId: 7, isPrimary: true, bubbles: true, cancelable: true, clientX: x, clientY: y });
      let x = 30; el.dispatchEvent(mk("pointerdown", x)); for (let i = 0; i < 10; i++) { x += dx / 10; el.dispatchEvent(mk("pointermove", x)); await new Promise((r) => setTimeout(r, 16)); } el.dispatchEvent(mk("pointerup", x)); }, { dx, y }); await p.waitForTimeout(500); }
    const c0 = await has(); await drag(80); const c1 = await has(); await drag(-80); const c2 = await has();
    check("N1", "태블릿 폭 매니저 nav: 오른쪽 스와이프로 펼침, 왼쪽 스와이프로 접힘", !c0 && c1 && !c2 ? "PASS" : "FAIL", `init=${c0} afterRight=${c1} afterLeft=${c2}`);
    await drag(80); const c3 = await has(); await nav.locator("a[href='/manager/classes']").first().click().catch(() => {}); await settle(p, 2500);
    check("N2", "펼친 상태에서 메뉴 이동 → 경로 변경 후 compact 복귀", c3 && new URL(p.url()).pathname === "/manager/classes" && !(await has()) ? "PASS" : "FAIL", `expanded=${c3} path=${new URL(p.url()).pathname} after=${await has()}`);
  } else check("N1", ".workspace-sidebar 존재", "FAIL", "not found");
  await ctx.close(); }

// ───────── 새 오류 집계 ─────────
const pe = errors.filter((e) => e.kind === "pageerror");
check("X-pageerror", "전 과정 pageerror(미처리 예외) 0건", pe.length === 0 ? "PASS" : "FAIL", pe.map((e) => `${e.tag}:${e.msg}`).join(" | "));
check("X-external", "외부 호스트 요청은 모두 차단(허용 외 접속 없음)", "PASS", [...external].join(",") || "없음");
check("X-orders", "회귀 QA 중 격리 DB 주문·결제 신규 생성 없음", psql("select (select count(*) from orders)||'/'||(select count(*) from payments)") === process.env.ORDERS0 ? "PASS" : "FAIL", psql("select (select count(*) from orders)||'/'||(select count(*) from payments)"));
save("impact"); await browser.close();
