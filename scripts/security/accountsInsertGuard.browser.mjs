// 브라우저 가입 화면(이메일 → 이름·휴대폰 OTP 인증·약관 동의)을 실제로 진행하고, 가입한 세션의 토큰으로 특권 컬럼 우회를 시도해 거부되는지 단언한다.
// 일회용 로컬 스택 + 개발 서버(APP_BASE, 기본 http://localhost:3402) 전용. 하나라도 기대와 다르면 종료 코드 1. 사용: ISO_ENV_FILE=… node accountsInsertGuard.browser.mjs <출력 디렉터리>
import fs from "node:fs"; import path from "node:path"; import crypto from "node:crypto";
import { createRequire } from "node:module"; const require = createRequire(process.cwd() + "/package.json"); const { chromium } = require("playwright"); const { createClient } = require("@supabase/supabase-js");
import { loadIsolatedEnv } from "./lib/assertIsolated.mjs";
const env = loadIsolatedEnv(process.env.ISO_ENV_FILE); const base = process.env.APP_BASE ?? "http://localhost:3402";
if (!/^http:\/\/localhost:\d+$/.test(base)) throw new Error("ISOLATED_GUARD: 앱 주소는 http://localhost:<포트> 만 허용");
const OUT = process.argv[2]; fs.mkdirSync(OUT, { recursive: true });
const svc = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
let failures = 0; const results = [];
const expectEq = (id, name, expected, actual, extra = "") => { const pass = expected === actual; if (!pass) failures++; results.push({ id, name, expected, actual, pass, extra }); console.log(`${pass ? "PASS" : "FAIL"} ${id} ${name} — 기대 ${expected} / 실제 ${actual}${extra ? " · " + extra : ""}`); };
const browser = await chromium.launch(); const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
async function uiSignup(page, { email, password, phone }, { mutateBody } = {}) {
  const posts = []; const onReq = (r) => { if (r.method() === "POST" && /\/rest\/v1\/accounts(\?|$)/.test(r.url())) posts.push(r.postData() ?? ""); }; page.on("request", onReq);
  if (mutateBody) await page.route(/\/rest\/v1\/accounts(\?|$)/, async (route) => { const req = route.request(); if (req.method() !== "POST") return route.continue(); const body = JSON.parse(req.postData() ?? "{}"); await route.continue({ postData: JSON.stringify(mutateBody(body)) }); });
  let err = "";
  try {
    await page.goto(base + "/login", { waitUntil: "networkidle" }); await page.waitForTimeout(800);
    await page.locator(".mode-tab", { hasText: "회원가입" }).click(); await page.waitForTimeout(300);
    await page.locator('input[aria-label="이메일"]').fill(email); await page.locator('input[type="password"]').first().fill(password);
    await page.locator("button.login-submit").click(); await page.waitForSelector('input[aria-label="이름"]', { timeout: 20000 });
    await page.locator('input[aria-label="이름"]').fill("보안시험"); await page.locator('input[aria-label="휴대폰 번호"]').fill(phone);
    await page.getByRole("button", { name: "인증번호 받기" }).click(); await page.waitForSelector('[data-testid="otp-dev-code"]', { timeout: 20000 });
    const code = ((await page.locator('[data-testid="otp-dev-code"]').innerText()).match(/\d{6}/) ?? [])[0]; if (!code) throw new Error("테스트 인증번호를 찾지 못함");
    await page.locator('input[placeholder="인증번호 6자리"]').fill(code); await page.getByRole("button", { name: "인증하기" }).click(); await page.waitForSelector("text=인증완료", { timeout: 20000 });
    await page.locator(".signup-agree-all input").check(); await page.locator("button.login-submit").click(); await page.waitForTimeout(6000);
  } catch (e) { err = String(e.message ?? e).slice(0, 160); }
  page.off("request", onReq); return { err, posts };
}
const nextCreds = (label) => { const t = crypto.randomBytes(3).toString("hex"); return { email: `sec-browser-${label}-${t}@isolated.test`, password: crypto.randomBytes(9).toString("base64url") + "Aa1!", phone: "01000001" + String(Math.floor(100 + Math.random() * 900)) }; };
const accountOf = async (email) => { const { data } = await svc.auth.admin.listUsers({ page: 1, perPage: 1000 }); const au = data.users.find((u) => u.email === email); const acc = au ? (await svc.from("accounts").select("id,phone,is_platform_admin,pg_checkout_override,merged_into").eq("auth_id", au.id).maybeSingle()).data : null; return { au, acc }; };
// ── 1) 정상 UI 가입 ──
const c1 = nextCreds("normal"); const p1 = await ctx.newPage(); const r1 = await uiSignup(p1, c1); await p1.screenshot({ path: path.join(OUT, "browser-after-signup.png") });
const signupError = r1.err; const accountPosts = r1.posts; const email = c1.email, password = c1.password, phone = c1.phone, page = p1;
expectEq("U0", "브라우저 가입 절차(이메일→휴대폰 OTP→동의→가입) 완료", "", signupError);
// 계정 상태(서버 관점)
const { au, acc } = await accountOf(email);
expectEq("U1", "UI 가입으로 계정 행이 만들어졌다", "exists", acc ? "exists" : "none");
expectEq("U2", "특권 값은 기본값(false/false/null)", "false/false/null", `${acc?.is_platform_admin}/${acc?.pg_checkout_override}/${acc?.merged_into}`);
expectEq("U3", "휴대폰 인증을 거친 번호가 저장됨(RLS 의 휴대폰 인증 조건 통과)", phone, acc?.phone ?? "");
expectEq("U4", "UI 가 보낸 accounts INSERT 본문에는 특권 컬럼이 없다", "0", String(accountPosts.filter((b) => /is_platform_admin|pg_checkout_override|merged_into|nicepay_review_access/.test(b)).length), `INSERT 요청 ${accountPosts.length}건`);
// 가입한 브라우저 세션의 토큰으로 우회 시도
let token = null; try { token = await page.evaluate(() => { const k = Object.keys(localStorage).find((x) => /^sb-.*-auth-token$/.test(x)); return k ? JSON.parse(localStorage.getItem(k)).access_token : null; }); } catch {}
if (!token) { const c = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } }); const { data } = await c.auth.signInWithPassword({ email, password }); token = data?.session?.access_token ?? null; }
expectEq("U5", "가입 세션 토큰을 확보", "yes", token ? "yes" : "no");
if (token && acc) {
  const cl = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false } });
  const attempts = [["is_platform_admin", true], ["pg_checkout_override", true], ["merged_into", acc.id]];
  for (const [col, val] of attempts) { const r = await cl.from("accounts").update({ [col]: val }).eq("auth_id", au.id).select("id"); expectEq("U6-" + col, `가입한 세션이 ${col} UPDATE`, "DENIED", r.error ? "DENIED" : (r.data?.length ? "UPDATED" : "0ROWS"), r.error?.message?.slice(0, 50) ?? ""); }
  // (삭제 후 재생성 경로는 프로필이 없는 계정으로 accountsInsertGuard.verify.mjs 가 단언한다 — UI 가입 계정은 프로필이 있어 삭제가 막힌다)
  const eff = await cl.rpc("is_platform_admin"); expectEq("U10", "세션의 is_platform_admin() 는 false", "false", String(eff.data));
}
// ── 2) 변조된 클라이언트 시뮬레이션: 실제 가입 화면을 그대로 진행하되, 앱이 보내는 accounts INSERT 본문에 특권 컬럼을 끼워 넣는다 ──
const victimAcc = (await svc.from("accounts").select("id").limit(1).maybeSingle()).data; const cleanup = [];
for (const [label, mut] of [["is_platform_admin", (b) => ({ ...b, is_platform_admin: true })], ["pg_checkout_override", (b) => ({ ...b, pg_checkout_override: true })], ["merged_into", (b) => ({ ...b, merged_into: victimAcc?.id })]]) {
  // 시도마다 새 브라우저 컨텍스트(이전 가입 세션 영향 없음)
  const cr = nextCreds("atk-" + label.slice(0, 5)); const cx = await browser.newContext({ viewport: { width: 390, height: 844 } }); const pg = await cx.newPage(); const rr = await uiSignup(pg, cr, { mutateBody: mut }); const { au: au2, acc: acc2 } = await accountOf(cr.email); if (au2) cleanup.push(au2.id);
  const state = !au2 ? "NO-AUTH-USER" : !acc2 ? "NO-ACCOUNT" : (acc2.is_platform_admin || acc2.pg_checkout_override || acc2.merged_into ? "PRIVILEGED:" + JSON.stringify({ a: acc2.is_platform_admin, o: acc2.pg_checkout_override, m: !!acc2.merged_into }) : "DEFAULT-ACCOUNT");
  expectEq("X-" + label, `변조 가입 요청(${label} 주입): 인증 사용자는 생기되 특권 계정 행은 만들어지지 않는다`, "NO-ACCOUNT", state, rr.err ? `UI 오류 ${rr.err.slice(0, 40)}` : "");
  await cx.close();
}
await browser.close(); for (const id of cleanup) { await svc.from("accounts").delete().eq("auth_id", id); await svc.auth.admin.deleteUser(id); } if (au) { await svc.from("accounts").delete().eq("auth_id", au.id); await svc.auth.admin.deleteUser(au.id); }
console.log(`\n${results.filter((x) => x.pass).length}/${results.length} PASS, ${failures} FAIL`); fs.writeFileSync(path.join(OUT, "browser-result.json"), JSON.stringify({ failures, results }, null, 1)); process.exit(failures ? 1 : 0);
