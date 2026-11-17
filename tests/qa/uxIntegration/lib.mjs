/*
  UX 통합 브랜치 격리 브라우저 QA 공용(로컬 격리 Supabase mwhabit-reviewpath 전용). 앱은 next start(127.0.0.1:3216) + scripts/qa/reviewPath/httpsProxy.mjs(3217)로 mwhabit.com 을 로컬로 매핑.
  준비: scripts/qa/uxPreview/localUxFixture.sql(시험 데이터)·세 번째 스택(REVIEWPATH_PORT_OFFSET=300 stack.sh up). 로그인은 격리 스택의 모의 계정(비밀번호는 출력·저장 안 함). 운영/공유 DB 와 무관.
*/
import fs from "node:fs"; import { createRequire } from "node:module"; import { execFileSync } from "node:child_process";
const WT = process.cwd();   // 저장소 루트에서 실행: ISO_ENV_FILE=<격리 env> node tests/qa/uxIntegration/<script>.mjs
const require = createRequire(WT + "/package.json"); export const { chromium } = require("playwright");
export const BASE = "https://mwhabit.com", OUT = process.env.OUT ?? WT + "/docs/qa/ux-integration-20261109/screenshots";
fs.mkdirSync(OUT, { recursive: true });
const env = {}; for (const ln of fs.readFileSync(process.env.ISO_ENV_FILE, "utf8").split("\n")) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(ln.trim()); if (m) env[m[1]] = m[2]; }
export { env };
export const psql = (sql) => execFileSync("docker", ["exec", "-i", "supabase_db_mwhabit-reviewpath", "psql", "-U", "postgres", "-At", "-v", "ON_ERROR_STOP=1", "-c", sql], { encoding: "utf8" }).trim();
export const UX = psql("select id from centers where name = '[UX] 격리 UX 시험 센터'");
export const pid = (name) => psql(`select id from products where name = '${name.replace(/'/g, "''")}'`);
export const browser = await chromium.launch({ args: ["--host-resolver-rules=MAP mwhabit.com:443 127.0.0.1:3217", "--ignore-certificate-errors"] });
export const external = new Set(); export const apiPosts = [];
export async function ctxFor(viewport = { width: 390, height: 844 }, login = true) {
  const ctx = await browser.newContext({ viewport }); const page = await ctx.newPage();
  await ctx.route("**/*", (route) => { const u = new URL(route.request().url());
    if (["mwhabit.com", "127.0.0.1", "localhost"].includes(u.hostname)) { if (u.hostname === "mwhabit.com" && u.pathname.startsWith("/api/") && route.request().method() !== "GET") apiPosts.push(`${route.request().method()} ${u.pathname}`); return route.continue(); }
    external.add(u.hostname); return route.abort(); });
  if (login) { await page.goto(`${BASE}/login`); await page.locator('input[type="email"]').fill(env.TEST_USER_A_EMAIL); await page.locator('input[type="password"]').fill(env.TEST_USER_A_PASSWORD); await page.locator("button.login-submit").click(); await page.waitForURL(`${BASE}/`, { timeout: 30000 }); }
  return { ctx, page };
}
export const results = [];
export const check = (id, name, status, detail = "") => { results.push({ id, name, status, detail: String(detail).slice(0, 240) }); console.log(`${status} ${id} ${name}${detail ? " — " + String(detail).slice(0, 240) : ""}`); };
export const save = (n) => fs.writeFileSync(OUT + `/../result-${n}.json`, JSON.stringify(results, null, 1));
export const settle = (p, ms = 2500) => p.waitForTimeout(ms);
