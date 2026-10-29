import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";

/* 만료 상품 자동 노출 종료 — 실브라우저(Chromium) 시험. 로컬 격리 스택 전용(데이터를 만든다): 가드가 로컬이 아니면 즉시 실패. 외부 결제·알림 없음. */
const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
let host = ""; try { host = new URL(URL_).hostname; } catch { /* */ }
if (!["127.0.0.1", "localhost"].includes(host)) throw new Error("ISOLATED_GUARD: 로컬 격리 Supabase 가 아니에요");
const need = (n: string) => { const v = process.env[n]; if (!v) throw new Error(`${n} 없음`); return v; };
const svc = createClient(URL_, need("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const psql = (sql: string) => execFileSync("docker", ["exec", "-i", "supabase_db_mwhabit-isolated", "psql", "-U", "postgres", "-At", "-v", "ON_ERROR_STOP=1", "-c", sql], { encoding: "utf8" }).trim();
const kst = (d = 0) => psql(`select to_char((now() at time zone 'Asia/Seoul')::date + ${d}, 'YYYY-MM-DD')`);
const tag = crypto.randomBytes(2).toString("hex"); const nm = (s: string) => `EXQ${tag}${s}`;
const shotDir = process.env.EXPIREDQA_OUT ? path.join(process.env.EXPIREDQA_OUT, "screenshots") : "test-results-expiredqa/screenshots";
const shot = async (page: Page, name: string, project: string) => { fs.mkdirSync(shotDir, { recursive: true }); await page.screenshot({ path: path.join(shotDir, `${project}-${name}.png`) }); };
let OP = ""; const ids: Record<string, string> = {};
test.beforeAll(async () => {
  OP = (await svc.from("centers").select("id").eq("name", "[QA] 심사 시험 스튜디오").single()).data!.id;
  for (const [k, mode, off] of [["어제", "date", -1], ["오늘", "date", 0], ["내일", "date", 1], ["일수", "days", 30]] as const) {
    const r = await svc.from("products").insert({ center_id: OP, name: nm(k), price: 12000, product_kind: "pass", pass_type: "count", total_count: 5, is_active: true, is_on_sale: true, visibility_type: "all", expiry_mode: mode, expiry_date: mode === "date" ? kst(off) : null, expiry_days: mode === "days" ? off === 1 ? 1 : 30 : null }).select("id").single();
    if (r.error) throw new Error(r.error.message); ids[k] = r.data.id;
  }
});
test.afterAll(async () => {
  const list = Object.values(ids).map((i) => `'${i}'`).join(",");
  psql(`begin; set local session_replication_role = replica; delete from orders where product_id in (${list}); delete from products where id in (${list}); commit;`);
});
async function loginMember(page: Page) {
  await page.goto("/login"); await page.locator('input[type="email"]').fill(need("TEST_USER_A_EMAIL")); await page.locator('input[type="password"]').fill(need("TEST_USER_A_PASSWORD"));
  await page.locator("button.login-submit").click(); await page.waitForURL("/", { timeout: 20_000 });
}
const buySheet = async (page: Page) => { await page.goto(`/center/${OP}?buy=1`); await page.waitForLoadState("networkidle"); await expect(page.locator(".center-product-row", { hasText: nm("내일") })).toBeVisible({ timeout: 20_000 }); };

test("[비회원] /products — 어제 만료 상품은 보이지 않고 오늘·내일·일수 상품은 보인다", async ({ page }, info) => {
  await page.goto("/products"); await page.waitForLoadState("networkidle");
  const body = page.locator("body"); await expect(body).toContainText(nm("오늘")); await expect(body).toContainText(nm("내일")); await expect(body).toContainText(nm("일수")); await expect(body).not.toContainText(nm("어제"));
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth); expect(overflow).toBeLessThanOrEqual(1);
  await shot(page, "01-guest-products", info.project.name);
});
test("[비회원] 센터 구매 시트 — 어제 만료 숨김, 이용기간이 거꾸로 표시되지 않음", async ({ page }, info) => {
  await buySheet(page); const body = page.locator("body");
  await expect(body).toContainText(nm("오늘")); await expect(body).not.toContainText(nm("어제"));
  const periods = await page.getByTestId("service-period-service").allInnerTexts();
  for (const t of periods) { const m = [...t.matchAll(/(\d{4})년 (\d{1,2})월 (\d{1,2})일/g)].map((x) => `${x[1]}${x[2].padStart(2, "0")}${x[3].padStart(2, "0")}`); if (m.length === 2) expect(m[0] <= m[1], `종료일이 시작일보다 앞서면 안 됨: ${t}`).toBe(true); }
  await shot(page, "02-guest-center-buy", info.project.name);
});
test("[로그인 회원] 구매 목록 — 어제 만료 숨김, 직접결제 주문 접수 가능(내일 만료 상품) + 카드·온라인 PG 미노출", async ({ page }, info) => {
  await loginMember(page); await buySheet(page); const body = page.locator("body");
  await expect(body).not.toContainText(nm("어제"));
  await page.goto(`/checkout?center=${OP}&product=${ids["내일"]}`); await expect(page.locator(".checkout-pay-btn")).toBeVisible({ timeout: 15_000 });
  const methods = (await page.locator(".pay-method").allInnerTexts()).join("|"); expect(methods).toContain("직접결제"); expect(methods).not.toMatch(/카드|토스|카카오페이|NICEPAY|나이스/);
  await shot(page, "03-member-checkout", info.project.name);
  await page.locator(".pay-method", { hasText: "직접결제" }).click(); await page.locator(".checkout-pay-btn").click();
  await expect(page.locator(".checkout-done-title", { hasText: "주문이 접수됐어요" })).toBeVisible({ timeout: 20_000 });
  expect((await svc.from("orders").select("id").eq("product_id", ids["내일"])).data?.length).toBe(1);
});
test("[로그인 회원] 만료 상품 직접 URL — 결제 화면이 상품을 찾지 못하고 주문이 생기지 않는다", async ({ page }, info) => {
  await loginMember(page); await page.goto(`/checkout?center=${OP}&product=${ids["어제"]}`); await page.waitForLoadState("networkidle");
  await expect(page.locator(".checkout-pay-btn")).toHaveCount(0); await expect(page.locator("body")).toContainText(/상품 정보를 찾을 수 없어요|구매할 수 없/);
  expect((await svc.from("orders").select("id").eq("product_id", ids["어제"])).data?.length ?? 0).toBe(0);
  await shot(page, "04-expired-direct-url", info.project.name);
});
test("[날짜 롤오버] 화면을 연 채 KST 자정이 지나면 오늘 만료 상품이 새로고침 없이 사라진다", async ({ page }, info) => {
  const today = kst(0); const [y, m, d] = today.split("-").map(Number);
  const justBeforeMidnightKst = new Date(Date.UTC(y, m - 1, d + 1, 0, 0, 0) - 9 * 3600_000 - 8_000);   // KST 23:59:52
  await page.clock.install({ time: justBeforeMidnightKst });
  await page.goto("/products"); await page.waitForLoadState("networkidle");
  await expect(page.locator("body")).toContainText(nm("오늘")); await shot(page, "05-before-midnight", info.project.name);
  await page.clock.fastForward(20_000);   // 자정 +12초
  await expect(page.locator("body")).not.toContainText(nm("오늘"), { timeout: 10_000 });
  await expect(page.locator("body")).toContainText(nm("내일")); await shot(page, "05-after-midnight", info.project.name);
});
