// 로컬 격리 스택 + 개발 서버(NEXT_PUBLIC_PAYMENT_PROVIDER=nicepay, PG 노출 플래그 없음) 전용. 5개 페르소나 × 화면 × (390/1440 × 라이트/다크).
// 결제 버튼은 누르지 않는다(주문 접수=직접결제 시험만 별도 단계). 사용: ISO_ENV_FILE=… APP_BASE=http://localhost:3402 node browserPersonas.mjs <outDir> <revCenter> <opCenter> <tossCenter> <revProduct> <opProduct> <tossProduct>
import { createRequire } from "node:module"; import fs from "node:fs"; import path from "node:path";
const require = createRequire(process.cwd() + "/package.json"); const { chromium } = require("playwright");
import { loadIsolatedEnv } from "./assertIsolated.mjs";
const env = loadIsolatedEnv(process.env.ISO_ENV_FILE); const base = process.env.APP_BASE ?? "http://localhost:3402"; if (!/^http:\/\/localhost:\d+$/.test(base)) throw new Error("ISOLATED_GUARD: 앱 주소는 http://localhost:<포트> 만 허용");
const [OUT, REV, OP, TOSS, REVP, OPP, TOSSP] = process.argv.slice(2); fs.mkdirSync(OUT, { recursive: true });
const VPS = { m390: { width: 390, height: 844 }, d1440: { width: 1440, height: 900 } }, THEMES = { light: "burgundy", dark: "charcoal" };
const WHO = { anon: null, A: [env.TEST_USER_A_EMAIL, env.TEST_USER_A_PASSWORD], T: [env.TOSS_REVIEWER_EMAIL, env.TOSS_REVIEWER_PASSWORD], B: [env.TEST_USER_B_EMAIL, env.TEST_USER_B_PASSWORD], S: [env.SONJW_LIKE_EMAIL, env.SONJW_LIKE_PASSWORD] };
const b = await chromium.launch(); const res = [];
for (const [vn, vp] of Object.entries(VPS)) for (const [tn, tk] of Object.entries(THEMES)) for (const [who, cred] of Object.entries(WHO)) {
  const ctx = await b.newContext({ viewport: vp }); await ctx.addInitScript((t) => { try { localStorage.setItem("app_theme", t); } catch {} }, tk); const page = await ctx.newPage(); const errs = []; page.on("pageerror", (e) => errs.push(e.message.slice(0, 80)));
  if (cred) { await page.goto(base + "/login", { waitUntil: "networkidle" }); await page.waitForTimeout(900); await page.locator('input[type="email"]').fill(cred[0]); await page.locator('input[type="password"]').fill(cred[1]); await page.locator("button.login-submit").click(); await page.waitForURL(base + "/", { timeout: 20000 }); }
  const T = async () => (await page.locator("body").innerText()).replace(/\s+/g, " ");
  const go = async (u) => { await page.goto(base + u, { waitUntil: "networkidle" }); await page.waitForTimeout(1800); };
  const shot = (n) => page.screenshot({ path: path.join(OUT, `${vn}-${tn}-${who}-${n}.png`), fullPage: true });
  const seen = (t) => ({ review: t.includes("NICEPAY 카드사 심사 환경"), op: t.includes("심사 시험 스튜디오"), toss: t.includes("로컬 시험 센터") });
  const rec = (pg, extra) => res.push({ vn, tn, who, page: pg, ...extra, errs: errs.length });
  await go("/"); rec("home", seen(await T())); await shot("home");
  await go("/category/" + encodeURIComponent("피겨스케이팅")); rec("category", seen(await T())); await shot("category");
  await go("/search"); await page.locator("input").first().fill("심사"); await page.waitForTimeout(2500); rec("search", seen(await T()));
  await go("/products"); rec("public-products", seen(await T()));
  for (const [lbl, id] of [["review", REV], ["op", OP], ["toss", TOSS]]) { await go("/center/" + id); const t = await T(); rec("center-" + lbl, { shown: !/찾을 수 없|존재하지/.test(t) && t.length > 80 }); if (lbl === "review") await shot("center-review"); }
  if (cred) {
    for (const [lbl, c, p] of [["review", REV, REVP], ["op", OP, OPP], ["toss", TOSS, TOSSP]]) { await go(`/checkout?center=${c}&product=${p}`); const m = (await page.locator(".pay-method").allInnerTexts()).map((s) => s.replace(/\s+/g, " ").replace(/[●○]/g, "").trim()); const t = await T(); rec("checkout-" + lbl, { methods: m, hasPeriod: await page.getByTestId("service-period").count() > 0, blocked: m.length === 0 }); if (lbl === "review") await shot("checkout-review"); }
    await go("/my-reservations"); rec("my-reservations", { ok: (await T()).length > 20 }); await go("/purchases"); rec("purchases", { ok: (await T()).length > 20 });
  }
  if (who === "S" || who === "A") { await go("/manager"); const t = await T(); rec("manager-home", { entered: /관리|센터|대시보드|매출/.test(t) && !/권한이 없|매니저 권한/.test(t), text: t.slice(0, 80) }); if (who === "S") await shot("manager-home"); }
  await ctx.close();
}
await b.close(); fs.writeFileSync(path.join(OUT, "personas-results.json"), JSON.stringify(res, null, 1)); console.log("done", res.length);
