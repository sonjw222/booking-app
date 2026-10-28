import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";

/* NICEPAY v3 결제창 격리 QA 공통 — 로컬 격리 Supabase(docker 컨테이너 supabase_db_mwhabit-isolated) + 모의 SDK + 모의 승인(fetch 가로채기). 실제 NICEPAY 호출 0건. */
export const BASE = "http://localhost:3100";
export const need = (n: string): string => { const v = process.env[n]; if (!v) throw new Error(`환경변수 ${n} 없음`); return v; };
{ let host = ""; try { host = new URL(need("NEXT_PUBLIC_SUPABASE_URL")).hostname; } catch { /* */ } if (!["127.0.0.1", "localhost"].includes(host)) throw new Error("ISOLATED_GUARD: 로컬 격리 Supabase 가 아니에요"); }
export const SDK_URL = "https://pg-web.nicepay.co.kr/v3/common/js/nicepay-pgweb.js";
export const OUT = process.env.NPQA_OUT ?? "test-results-nicepayqa";

export const psql = (sql: string): string => execFileSync("docker", ["exec", "-i", "supabase_db_mwhabit-isolated", "psql", "-U", "postgres", "-At", "-v", "ON_ERROR_STOP=1", "-c", sql], { encoding: "utf8" }).trim();
export const setGate = (m: "off" | "reviewer" | "public") => psql(`update nicepay_checkout_gate set mode='${m}', updated_at=now() where id`);
export const control = (o: Record<string, string>) => fs.writeFileSync(need("NICEPAY_QA_CONTROL"), JSON.stringify(o));
export const calls = (): Array<Record<string, unknown>> => { try { return fs.readFileSync(need("NICEPAY_QA_LOG"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
export const callCount = (kind: string) => calls().filter((c) => c.kind === kind).length;
export const shot = async (p: Page, name: string) => { fs.mkdirSync(path.join(OUT, "screenshots"), { recursive: true }); await p.screenshot({ path: path.join(OUT, "screenshots", `${name}.png`) }); };

export const reviewCenter = () => psql("select id from centers where is_nicepay_review limit 1");
export const reviewProduct = (nameLike: string) => psql(`select p.id from products p join centers c on c.id=p.center_id where c.is_nicepay_review and p.name like '%${nameLike}%' limit 1`);
export const opCenter = () => psql("select id from centers where name='[QA] 심사 시험 스튜디오' limit 1");
export const opProduct = () => psql("select id from products where name='[QA] 8회권 · 30일' limit 1");
export const productPrice = (id: string) => Number(psql(`select price from products where id='${id}'`));
export const orderRows = (acct: "A" | "B" | "T") => psql(`select coalesce(string_agg(id||':'||status||':'||coalesce(payment_provider,''), ',' order by created_at), '') from orders where profile_id in (select p.id from profiles p join accounts a on a.id=p.account_id where a.auth_id=(select id from auth.users where email='${need(acct === "A" ? "TEST_USER_A_EMAIL" : acct === "B" ? "TEST_USER_B_EMAIL" : "TOSS_REVIEWER_EMAIL")}')) and payment_provider='nicepay'`);
export const membershipsOf = (productId: string) => Number(psql(`select count(*) from memberships where product_id='${productId}'`));
export const cleanNicepayOrders = () => psql("begin; set local session_replication_role = replica; delete from nicepay_review_actions; create temp table _np_m on commit drop as select membership_id from payments where order_id in (select id from orders where payment_provider='nicepay') and membership_id is not null; delete from payments where order_id in (select id from orders where payment_provider='nicepay'); delete from memberships where id in (select membership_id from _np_m); delete from orders where payment_provider='nicepay'; commit;");

const CREDS = { A: ["TEST_USER_A_EMAIL", "TEST_USER_A_PASSWORD"], B: ["TEST_USER_B_EMAIL", "TEST_USER_B_PASSWORD"], T: ["TOSS_REVIEWER_EMAIL", "TOSS_REVIEWER_PASSWORD"] } as const;
const authDir = path.resolve(process.cwd(), "test-results-nicepayqa/.auth");
export async function sessionFor(browser: Browser, who: "A" | "B" | "T"): Promise<string> {
  const file = path.join(authDir, `${who}.json`); if (fs.existsSync(file)) return file;
  fs.mkdirSync(authDir, { recursive: true });
  const ctx = await browser.newContext(); const page = await ctx.newPage();
  await page.goto(`${BASE}/login`); await page.locator('input[type="email"]').fill(need(CREDS[who][0])); await page.locator('input[type="password"]').fill(need(CREDS[who][1]));
  await page.locator("button.login-submit").click(); await page.waitForURL(`${BASE}/`, { timeout: 20_000 });
  await ctx.storageState({ path: file }); await ctx.close(); return file;
}

/* 모의 NICEPAY v3 SDK(nicepay-pgweb.js 대체): goPay(form) → 모드에 따라 nicepaySubmit()/nicepayClose() 호출. 실제 SDK 는 외부 호스트라 네트워크 요청이 나가지 않게 route 로 가로챈다. */
const SDK_JS = `
window.goPay = function (form) {
  var mode = window.__QA_MODE || 'success';
  var g = function (n) { var e = form.elements[n]; return e ? e.value : undefined; };
  window.__QA_GOPAY = (window.__QA_GOPAY || 0) + 1;
  window.__QA_FORM = { MID: g('MID'), Moid: g('Moid'), Amt: g('Amt'), PayMethod: g('PayMethod'), ReturnURL: form.action, acceptCharset: form.getAttribute('accept-charset'), names: Array.prototype.map.call(form.elements, function (e) { return e.name; }) };
  if (window.__QA_REPORT) window.__QA_REPORT(window.__QA_FORM);
  if (mode === 'sdkthrow') throw new Error('QA SDK error');
  if (mode === 'close') { setTimeout(function () { window.nicepayClose && window.nicepayClose(); }, 50); return; }
  var token = 'QATOK_' + g('Moid');
  var amt = mode === 'amtmismatch' ? String(Number(g('Amt')) + 1000) : g('Amt');
  window.__QA_SIGN(token, g('MID'), amt).then(function (sig) {
    var add = function (n, v) { var i = document.createElement('input'); i.type = 'hidden'; i.name = n; i.value = v; form.appendChild(i); };
    if (mode === 'amtmismatch') form.elements['Amt'].value = amt;
    add('AuthResultCode', mode === 'authfail' ? '3001' : '0000'); add('AuthResultMsg', mode === 'authfail' ? 'QA 인증 실패' : 'QA 인증 성공'); add('AuthToken', token); add('PayMethod', 'CARD');
    add('Signature', mode === 'badsig' ? new Array(65).join('0') : sig); add('TxTid', 'QATID' + Date.now());
    add('NextAppURL', mode === 'evilurl' ? 'https://evil.example.test/webapi/pay_process.jsp' : 'https://webapi.nicepay.co.kr/webapi/pay_process.jsp'); add('NetCancelURL', 'https://webapi.nicepay.co.kr/webapi/net_cancel.jsp');
    window.nicepaySubmit();
  });
};`;
export async function installMockSdk(page: Page, mode: string): Promise<void> {
  await page.exposeFunction("__QA_REPORT", (o: Record<string, unknown>) => { (page as unknown as { __forms?: unknown[] }).__forms = [...((page as unknown as { __forms?: unknown[] }).__forms ?? []), o]; });
  await page.addInitScript((m) => { (window as unknown as { __QA_MODE: string }).__QA_MODE = m; }, mode);
  await page.exposeFunction("__QA_SIGN", async (token: string, mid: string, amt: string) => crypto.createHash("sha256").update(token + mid + amt + need("NICEPAY_MERCHANT_KEY"), "utf8").digest("hex"));
  await page.route(SDK_URL, (route) => route.fulfill({ status: 200, contentType: "application/javascript", body: SDK_JS }));
}
export const formsOf = (page: Page) => ((page as unknown as { __forms?: Array<Record<string, unknown>> }).__forms ?? []);
export const setMode = (page: Page, mode: string) => page.evaluate((m) => { (window as unknown as { __QA_MODE: string }).__QA_MODE = m; }, mode);

export async function openAs(browser: Browser, who: "A" | "B" | "T", mode = "success"): Promise<{ ctx: BrowserContext; page: Page; external: string[]; errors: string[] }> {
  const ctx = await browser.newContext({ storageState: await sessionFor(browser, who), viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage(); const external: string[] = []; const errors: string[] = [];
  page.on("request", (r) => { if (r.url() === SDK_URL) return; /* 모의 SDK 로 대체(route fulfill) — 네트워크 미발생 */ const h = new URL(r.url()).hostname; if (!["localhost", "127.0.0.1"].includes(h)) external.push(h); });
  page.on("pageerror", (e) => errors.push(e.message));
  await installMockSdk(page, mode);
  return { ctx, page, external, errors };
}
export async function gotoCheckout(page: Page, productId: string, centerId = reviewCenter()) {
  await page.goto(`${BASE}/checkout?center=${centerId}&product=${productId}`); await page.waitForLoadState("networkidle");
}
export { expect, test };
