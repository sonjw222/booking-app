// 로컬 격리 스택 + 개발 서버(:3402) 전용. 카테고리 화면, 기존 예약·구매 이력 화면을 비회원/일반/심사관으로 확인한다(390/1440 × 라이트/다크).
import { createRequire } from "node:module"; import fs from "node:fs"; import path from "node:path";
const require = createRequire(process.cwd() + "/package.json"); const { chromium } = require("playwright");
import { loadIsolatedEnv } from "./assertIsolated.mjs";
const env = loadIsolatedEnv(process.env.ISO_ENV_FILE); const base = process.env.APP_BASE ?? "http://localhost:3402"; if (!/^http:\/\/localhost:\d+$/.test(base)) throw new Error("ISOLATED_GUARD: 앱 주소는 http://localhost:<포트> 만 허용");
const OUT = process.argv[2]; fs.mkdirSync(OUT, { recursive: true });
const VPS = { m390: { width: 390, height: 844 }, d1440: { width: 1440, height: 900 } }, THEMES = { light: "burgundy", dark: "charcoal" };
const b = await chromium.launch(); const res = [];
for (const [vn, vp] of Object.entries(VPS)) for (const [tn, tk] of Object.entries(THEMES)) for (const who of ["anon", "A", "B"]) {
  const ctx = await b.newContext({ viewport: vp }); await ctx.addInitScript((t) => { try { localStorage.setItem("app_theme", t); } catch {} }, tk); const page = await ctx.newPage(); const errs = []; page.on("pageerror", (e) => errs.push(e.message.slice(0, 80)));
  if (who !== "anon") { const [e, p] = who === "A" ? [env.TEST_USER_A_EMAIL, env.TEST_USER_A_PASSWORD] : [env.TEST_USER_B_EMAIL, env.TEST_USER_B_PASSWORD]; await page.goto(base + "/login", { waitUntil: "networkidle" }); await page.waitForTimeout(900); await page.locator('input[type="email"]').fill(e); await page.locator('input[type="password"]').fill(p); await page.locator("button.login-submit").click(); await page.waitForURL(base + "/"); }
  const T = async () => (await page.locator("body").innerText()).replace(/\s+/g, " ");
  const go = async (u) => { await page.goto(base + u, { waitUntil: "networkidle" }); await page.waitForTimeout(1800); };
  const shot = (n) => page.screenshot({ path: path.join(OUT, `${vn}-${tn}-${who}-${n}.png`), fullPage: true });
  await go("/category/" + encodeURIComponent("피겨스케이팅")); let t = await T(); await shot("category"); res.push({ vn, tn, who, page: "category", seesReview: t.includes("MWHABIT NICEPAY"), seesOp: t.includes("심사 시험 스튜디오"), errs: errs.length });
  if (who !== "anon") {
    await go("/my-reservations"); t = await T(); await shot("my-reservations"); res.push({ vn, tn, who, page: "my-reservations", shownOpReservation: t.includes("[QA] 운영 센터 수업"), errs: errs.length });
    await go("/purchases"); t = await T(); await shot("purchases"); res.push({ vn, tn, who, page: "purchases", shownOpHistory: t.includes("[QA] 8회권 · 30일"), shownReviewOrder: t.includes("[심사용]"), errs: errs.length });
  }
  await ctx.close();
}
await b.close(); fs.writeFileSync(path.join(OUT, "history-category-results.json"), JSON.stringify(res, null, 1));
for (const r of res.filter((x) => x.vn === "m390" && x.tn === "light")) console.log(JSON.stringify(r));
