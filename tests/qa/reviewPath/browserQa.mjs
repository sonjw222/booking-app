/*
  심사 경로 격리 브라우저 QA — 로컬 격리 Supabase(mwhabit-reviewpath, 127.0.0.1:54621) + 앱 next start(127.0.0.1:3216) + https 프록시(3217, mwhabit.com 으로 호스트 매핑).
  실제 Chromium. 로그인은 "격리 스택에 만든 모의 계정"(niceqa 와 같은 UID·형태, 무작위 비밀번호) — 운영 계정·운영 Supabase 와 무관. NICEPAY SDK 는 stub(외부 요청 0), 그 밖 외부 호스트는 차단·집계한다.
  사용: ISO_ENV_FILE=<env> OUT=<디렉터리> node tests/qa/reviewPath/browserQa.mjs   (비밀번호는 출력·저장하지 않는다)
*/
import fs from "node:fs"; import path from "node:path"; import { execFileSync } from "node:child_process"; import { createRequire } from "node:module";
const require = createRequire(process.cwd() + "/package.json"); const { chromium } = require("playwright"); const { createClient } = require("@supabase/supabase-js");
const envFile = process.env.ISO_ENV_FILE, OUT = process.env.OUT ?? "docs/qa/nicepay-review-path-20261106";
const env = {}; for (const ln of fs.readFileSync(envFile, "utf8").split("\n")) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(ln.trim()); if (m) env[m[1]] = m[2]; }
const host = new URL(env.NEXT_PUBLIC_SUPABASE_URL).hostname; if (!["127.0.0.1", "localhost"].includes(host)) { console.error("ABORT: 로컬 격리 Supabase 가 아님"); process.exit(1); }
const BASE = "https://mwhabit.com", SDK = "https://pg-web.nicepay.co.kr/v3/common/js/nicepay-pgweb.js";
const psql = (sql) => execFileSync("docker", ["exec", "-i", "supabase_db_mwhabit-reviewpath", "psql", "-U", "postgres", "-At", "-v", "ON_ERROR_STOP=1", "-c", sql], { encoding: "utf8" }).trim();
const A10 = psql("select id from centers where name = 'A10TION 피겨팀'");   // 실제 UUID 리터럴을 코드에 두지 않는다(격리 DB 에서 이름으로 조회)
if (!/^[0-9a-f-]{36}$/.test(A10)) { console.error("ABORT: A10TION 시드 센터가 없음"); process.exit(1); }
fs.mkdirSync(path.join(OUT, "screenshots"), { recursive: true });
const results = []; const check = (id, name, ok, detail = "") => { results.push({ id, name, ok: !!ok, detail: String(detail).slice(0, 200) }); console.log(`${ok ? "PASS" : "FAIL"} ${id} ${name}${ok ? "" : " — " + detail}`); };
const blocked = new Set(); const apiCalls = [];
const SDK_JS = `window.goPay=function(form){window.__GOPAY=(window.__GOPAY||0)+1;var g=function(n){var e=form.elements[n];return e?e.value:undefined};window.__FORM={MID:g('MID'),Amt:g('Amt'),PayMethod:g('PayMethod'),ReturnURL:form.action,Moid:g('Moid')};};`;
const browser = await chromium.launch({ args: ["--host-resolver-rules=MAP mwhabit.com:443 127.0.0.1:3217", "--ignore-certificate-errors"] });
async function ctxFor(login) {
  const ctx = await browser.newContext({ viewport: { width: 430, height: 900 } }); const page = await ctx.newPage();
  await ctx.route("**/*", (route) => {
    const u = new URL(route.request().url());
    if (route.request().url() === SDK) return route.fulfill({ contentType: "application/javascript", body: SDK_JS });
    if (["mwhabit.com", "127.0.0.1", "localhost"].includes(u.hostname)) { if (u.hostname === "mwhabit.com" && u.pathname.startsWith("/api/")) apiCalls.push(`${route.request().method()} ${u.pathname}`); return route.continue(); }
    blocked.add(u.hostname); return route.abort();
  });
  if (login) { await page.goto(`${BASE}/login`); await page.locator('input[type="email"]').fill(env[login[0]]); await page.locator('input[type="password"]').fill(env[login[1]]); await page.locator("button.login-submit").click(); await page.waitForURL(`${BASE}/`, { timeout: 30_000 }); }
  return { ctx, page };
}
const settle = async (page, ms = 2000) => { await page.waitForLoadState("domcontentloaded"); await page.waitForTimeout(ms); };
const shot = (page, n) => page.screenshot({ path: path.join(OUT, "screenshots", `${n}.png`) });
const REVIEW_SECTION = 'section[aria-label="수강권 및 결제 확인 센터"]';

// ── 심사관(모의 niceqa) ──
{
  const { ctx, page } = await ctxFor(["NICEQA_EMAIL", "NICEQA_PASSWORD"]);
  await settle(page);
  const sec = page.locator(REVIEW_SECTION); check("R1", "심사관 홈: '수강권 및 결제 확인 센터' 섹션에 A10TION 피겨팀 표시", (await sec.count()) === 1 && (await sec.innerText()).includes("A10TION 피겨팀"));
  const homeText = await page.locator("body").innerText(); check("R2", "심사관 홈: 별도 심사 센터(테스트 상품 센터) 미노출, '심사용' 문구 없음", !homeText.includes("MWHABIT NICEPAY") && !/심사용|심사 전용|심사 안내/.test(homeText));
  await shot(page, "01-reviewer-home");
  await page.goto(`${BASE}/products`); await settle(page);
  const prod = await page.locator("body").innerText(); const ACTIVE = ["11월 스케줄링 수강권", "11월 요일고정 수강권", "11월 4주완성 수강권"];
  check("R3", "심사관 /products: A10TION 판매 중 수강권 3종 표시", ACTIVE.every((n) => prod.includes(n)), ACTIVE.filter((n) => !prod.includes(n)).join(","));
  check("R4", "심사관 /products: 만료된 10월 상품·다른 센터 상품 미노출", !prod.includes("10월 수강권") && !prod.includes("MWHABIT NICEPAY"), `has10=${prod.includes("10월 수강권")} hasReviewCenter=${prod.includes("MWHABIT NICEPAY")} text=${prod.replace(/\s+/g, " ").slice(0, 160)}`);
  await shot(page, "02-reviewer-products");
  await page.goto(`${BASE}/center/${A10}?buy=1`); await settle(page);
  const rows = await page.locator(".center-product-row").count(); check("R5", "조회 전용 센터 상세: 상품 3종 행", rows === 3, rows);
  check("R6", "조회 전용: 구매·담기·예약 버튼 없음, 안내 문구 표시", (await page.locator(".center-product-buy").count()) === 0 && (await page.locator(".center-product-cart").count()) === 0 && (await page.getByText("수강권 · 상품 안내").count()) > 0 && (await page.getByText("예약하기").count()) === 0);
  const links = page.getByText("결제 화면 · 카드 결제창 확인"); check("R7", "상품 행마다 '결제 화면 · 카드 결제창 확인' 링크 3개", (await links.count()) === 3, await links.count());
  await shot(page, "03-reviewer-center-viewonly");
  await links.first().click(); await page.waitForURL(/\/checkout\?center=/, { timeout: 20_000 }); await settle(page, 2500);
  const payBtn = page.locator("button.checkout-pay-btn"); const payText = await payBtn.innerText();
  check("R8", "결제 화면: 실제 결제 버튼 비활성·'조회 전용' 표시, 안내 문구", (await payBtn.isDisabled()) && payText.includes("조회 전용") && (await page.getByTestId("view-only-notice").count()) === 1, payText);
  const card = page.locator('section[aria-label="카드 결제창 확인"]'); check("R9", "결제 화면: '카드 결제창 확인(승인 없음)' 카드 표시(심사관·허용 센터 상품)", (await card.count()) === 1 && (await card.innerText()).includes("승인 없음"));
  await shot(page, "04-reviewer-checkout");
  const price = Number(psql(`select price from products where center_id='${A10}' and name like '%스케줄링%'`));
  await card.getByRole("button").first().click(); await page.waitForTimeout(2500);
  const gp = await page.evaluate(() => ({ n: window.__GOPAY ?? 0, f: window.__FORM ?? null }));
  check("R10", "인증창 호출: goPay 1회, 공용 테스트 MID, 금액=상품 기본가, 전용 복귀 URL", gp.n === 1 && gp.f?.MID === "nicepay00m" && gp.f?.Amt === String(price) && /\/api\/payments\/nicepay\/review-window\/return\?rt=/.test(gp.f?.ReturnURL ?? ""), JSON.stringify({ n: gp.n, MID: gp.f?.MID, Amt: gp.f?.Amt }));
  await shot(page, "05-reviewer-auth-window-opened-stub");
  check("R11", "인증창 열림 상태: 버튼 잠금 + 상태 초기화 제공(준비 중에 갇히지 않음)", (await card.getByRole("button", { name: /열려 있어요/ }).isDisabled()) && (await card.getByRole("button", { name: /상태 초기화/ }).count()) === 1);
  await ctx.close();
  const nonReview = apiCalls.filter((c) => c.includes("/api/payments/") && !c.includes("/review-window")); check("R12", "인증창 확인 중 승인·prepare·return-token·confirm 등 결제 API 호출 0건(review-window 만)", nonReview.length === 0, nonReview.join(";"));
  check("R13", "review-window API 호출은 check/open POST 뿐", apiCalls.filter((c) => c.includes("/review-window")).every((c) => c.startsWith("POST ")), apiCalls.filter((c) => c.includes("/review-window")).join(";"));
}
// ── 서버 측 구매 차단(심사관 JWT, 격리 DB) ──
{
  const c = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  const s = await c.auth.signInWithPassword({ email: env.NICEQA_EMAIL, password: env.NICEQA_PASSWORD }); check("S0", "모의 심사 계정 로그인(격리 GoTrue)", !s.error && s.data.session, s.error?.message);
  const prof = psql(`select p.id from profiles p join accounts a on a.id=p.account_id join auth.users u on u.id=a.auth_id where u.email='${env.NICEQA_EMAIL}' limit 1`);
  const pid = psql(`select id from products where center_id='${A10}' and name like '%4주완성%'`);
  const o = await c.rpc("create_order_secure", { p_product_id: pid, p_pay_method: "direct", p_selected_size: null, p_point_used: 0, p_auto_book: false, p_provider: null }); check("S1", "조회 전용: create_order_secure 거부", !!o.error, o.error?.message);
  const ci = await c.from("cart_items").insert({ profile_id: prof, center_id: A10, product_id: pid, product_name: "x" }).select("id").single(); check("S2", "조회 전용: 장바구니 담기 거부", !!ci.error, ci.error?.message);
  const pr = await c.from("purchase_requests").insert({ center_id: A10, profile_id: prof, product_name: "x" }).select("id").single(); check("S3", "조회 전용: 구매신청 거부", !!pr.error, pr.error?.message);
  const n = psql(`select (select count(*) from orders where center_id='${A10}')||','||(select count(*) from cart_items where center_id='${A10}')||','||(select count(*) from purchase_requests where center_id='${A10}')||','||(select count(*) from memberships m join products p on p.id=m.product_id where p.center_id='${A10}')`);
  check("S4", "A10TION 주문·장바구니·구매신청·수강권 행 0건(인증창 확인·구매 시도 이후)", n === "0,0,0,0", n);
  const sess = await c.rpc("nicepay_my_review_center_ids"); check("S5", "허용 센터 RPC: A10TION 1건, can_purchase=false", Array.isArray(sess.data) && sess.data.length === 1 && sess.data[0].center_id === A10 && sess.data[0].can_purchase === false, JSON.stringify(sess.data));
}
// ── 일반 회원(USER_A) ──
{
  const { ctx, page } = await ctxFor(["TEST_USER_A_EMAIL", "TEST_USER_A_PASSWORD"]); await settle(page);
  const body = await page.locator("body").innerText();
  check("G1", "일반 회원 홈: 심사관 섹션·'결제 확인 센터' 없음, 심사 센터 미노출", (await page.locator(REVIEW_SECTION).count()) === 0 && !body.includes("MWHABIT NICEPAY") && !body.includes("수강권 및 결제 확인 센터"));
  await shot(page, "06-member-home");
  await page.goto(`${BASE}/center/${A10}?buy=1`); await settle(page);
  const buy = await page.locator(".center-product-buy").count(); check("G2", "일반 회원: 실제 센터(A10TION)는 정상(구매 버튼 있음·조회 전용 아님·결제창 확인 링크 없음)", buy > 0 && (await page.getByText("결제 화면 · 카드 결제창 확인").count()) === 0 && (await page.getByTestId("view-only-notice").count()) === 0, buy);
  const rc = psql("select id from centers where is_nicepay_review limit 1"); await page.goto(`${BASE}/center/${rc}`); await settle(page);
  const rb = await page.locator("body").innerText(); check("G3", "일반 회원: 심사 센터 직접 URL 은 센터 정보를 보여 주지 않음", !rb.includes("MWHABIT NICEPAY") && (await page.locator(".center-product-row").count()) === 0, rb.slice(0, 60));
  await shot(page, "07-member-review-center-direct");
  await page.goto(`${BASE}/checkout?center=${A10}&product=${psql(`select id from products where center_id='${A10}' and name like '%4주완성%'`)}`); await settle(page, 2500);
  check("G4", "일반 회원 결제 화면: 심사 인증창 카드 없음, 카드 결제는 비노출(직접결제만)", (await page.locator('section[aria-label="카드 결제창 확인"]').count()) === 0 && (await page.getByText("신용/체크카드").count()) === 0);
  await ctx.close();
}
// ── 비로그인 ──
{
  const { ctx, page } = await ctxFor(null); await page.goto(`${BASE}/`); await settle(page);
  const body = await page.locator("body").innerText();
  check("N1", "비로그인 홈: 심사관 섹션·심사 센터 없음", (await page.locator(REVIEW_SECTION).count()) === 0 && !body.includes("MWHABIT NICEPAY"));
  const rc = psql("select id from centers where is_nicepay_review limit 1"); await page.goto(`${BASE}/center/${rc}`); await settle(page);
  check("N2", "비로그인: 심사 센터 직접 URL 은 상품·센터 정보를 보여 주지 않음", (await page.locator(".center-product-row").count()) === 0 && !(await page.locator("body").innerText()).includes("MWHABIT NICEPAY"));
  const r = await ctx.request.post(`${BASE}/api/payments/nicepay/review-window`, { data: { productId: psql(`select id from products where center_id='${A10}' limit 1`), action: "check" }, headers: { Origin: BASE } });
  check("N3", "비로그인: review-window check 거부(allowed 아님)", r.status() !== 200, r.status());
  await ctx.close();
}
await browser.close();
// 외부 호스트·결제 설정 요약
check("X1", "외부 호스트로 나간 요청 0건(차단된 호스트 집계)", blocked.size === 0, `blocked hosts: ${[...blocked].join(",") || "none"}`);
const pass = results.filter((r) => r.ok).length; fs.writeFileSync(path.join(OUT, "browser-qa-results.json"), JSON.stringify({ pass, total: results.length, blockedHosts: [...blocked], results }, null, 2));
console.log(`\n결과: ${pass}/${results.length} PASS, 차단된 외부 호스트: ${[...blocked].join(",") || "없음"}`); process.exit(pass === results.length ? 0 : 1);
