import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";

/* /manager/orders 만료 상품 주문 처리 — 실브라우저(Chromium) 시험. 로컬 격리 스택 전용(데이터를 만든다): 가드가 로컬이 아니면 즉시 실패. 외부 결제·알림 없음. */
const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
let host = ""; try { host = new URL(URL_).hostname; } catch { /* */ }
if (!["127.0.0.1", "localhost"].includes(host)) throw new Error("ISOLATED_GUARD: 로컬 격리 Supabase 가 아니에요");
const need = (n: string) => { const v = process.env[n]; if (!v) throw new Error(`${n} 없음`); return v; };
const svc = createClient(URL_, need("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const psql = (sql: string) => execFileSync("docker", ["exec", "-i", "supabase_db_mwhabit-isolated", "psql", "-U", "postgres", "-At", "-v", "ON_ERROR_STOP=1", "-c", sql], { encoding: "utf8" }).trim();
const kst = (d = 0) => psql(`select to_char((now() at time zone 'Asia/Seoul')::date + ${d}, 'YYYY-MM-DD')`);
const tag = crypto.randomBytes(2).toString("hex"); const nm = (s: string) => `EXO${tag}${s}`;
const shotDir = process.env.EXPIREDORDER_OUT ? path.join(process.env.EXPIREDORDER_OUT, "screenshots") : "test-results-expiredorder/screenshots";
const shot = async (page: Page, name: string, project: string) => { fs.mkdirSync(shotDir, { recursive: true }); await page.screenshot({ path: path.join(shotDir, `${project}-${name}.png`) }); };
const confirmDialog = async (page: Page) => { const b = page.getByRole("button", { name: /^(계속하기|확인)$/ }).last(); await b.waitFor({ state: "visible", timeout: 10_000 }); await b.click(); };
test.describe.configure({ mode: "serial" });
let OP = "", PROFILE = ""; const prod: Record<string, string> = {}; const ord: Record<string, string> = {};

async function mkOrder(key: string, productKey: string) {
  const r = await svc.from("orders").insert({ center_id: OP, profile_id: PROFILE, product_id: prod[productKey], product_name: nm(productKey), amount: 80000, pay_method: "direct", status: "pending" }).select("id").single();
  if (r.error) throw new Error(r.error.message); ord[key] = r.data.id;
}
const status = async (k: string) => (await svc.from("orders").select("status").eq("id", ord[k]).single()).data?.status;
const cnt = async (t: "memberships" | "payments" | "order_expiry_resolutions", k: string) => {
  const q = svc.from(t).select("id", { count: "exact", head: true });
  const r = t === "memberships" ? await q.eq("product_id", prod["만료"]).eq("profile_id", PROFILE) : await q.eq("order_id", ord[k]);
  return r.count ?? 0;
};
test.beforeAll(async () => {
  OP = (await svc.from("centers").select("id").eq("name", "[QA] 심사 시험 스튜디오").single()).data!.id;
  PROFILE = psql(`select p.id from profiles p join accounts a on a.id = p.account_id where a.auth_id = (select id from auth.users where email = '${need("TEST_USER_A_EMAIL")}') limit 1`);
  if (!PROFILE) throw new Error("회원 프로필 없음");
  for (const [k, off] of [["만료", -3], ["정상", 30]] as const) {
    const r = await svc.from("products").insert({ center_id: OP, name: nm(k), price: 80000, product_kind: "pass", pass_type: "count", total_count: 5, is_active: true, is_on_sale: true, visibility_type: "all", expiry_mode: "date", expiry_date: kst(off) }).select("id").single();
    if (r.error) throw new Error(r.error.message); prod[k] = r.data.id;
  }
  for (const k of ["미수납", "환불", "조정", "모름"]) await mkOrder(k, "만료");
  await mkOrder("정상", "정상");
});
test.afterAll(async () => {
  const pl = Object.values(prod).map((i) => `'${i}'`).join(",");
  psql(`begin; set local session_replication_role = replica; delete from order_expiry_resolutions where order_id in (select id from orders where product_id in (${pl})); delete from payments where order_id in (select id from orders where product_id in (${pl})); delete from memberships where product_id in (${pl}); delete from orders where product_id in (${pl}); delete from products where id in (${pl}); commit;`);
});
async function loginManager(page: Page) {
  await page.goto("/login"); await page.locator('input[type="email"]').fill(need("TEST_MANAGER_A_EMAIL")); await page.locator('input[type="password"]').fill(need("TEST_MANAGER_A_PASSWORD"));
  await page.locator("button.login-submit").click(); await page.waitForURL("/", { timeout: 20_000 });
}
async function openOrders(page: Page) {
  await page.goto("/manager/orders"); await page.waitForLoadState("networkidle");
  const select = page.getByLabel("센터 선택");
  if (await select.count()) { if ((await select.first().inputValue()) !== OP) { await select.first().selectOption(OP); await page.waitForLoadState("networkidle"); } }
  await expect(page.getByText(nm("정상")).first()).toBeVisible({ timeout: 20_000 });
}
const row = (page: Page, k: string) => page.locator(".order-row", { has: page.locator(`text=${nm(k === "정상" ? "정상" : "만료")}`) });
const rowOf = (page: Page, id: string) => page.locator(".order-row").filter({ hasText: nm("만료") });   // 만료 상품 주문 행 모음
test("로그인 후 주문 화면 — 만료 상품 주문은 수납 확인 안내, 정상 주문 UI는 그대로", async ({ page }, info) => {
  await loginManager(page); await openOrders(page);
  await expect(page.getByTestId("expired-order-notice")).toHaveCount(4);
  await expect(page.getByTestId("expired-order-resolve-btn")).toHaveCount(4);
  const normal = page.locator(".order-row").filter({ hasText: nm("정상") });
  await expect(normal.getByRole("button", { name: "확정 · 발급" })).toBeVisible(); await expect(normal.getByRole("button", { name: "취소", exact: true })).toBeVisible();
  await expect(normal.getByTestId("expired-order-notice")).toHaveCount(0);
  const expiredRows = page.locator(".order-row").filter({ hasText: nm("만료") });
  await expect(expiredRows.getByRole("button", { name: "확정 · 발급" })).toHaveCount(0);   // 일반 발급 버튼 우회 불가
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
  await shot(page, "01-orders", info.project.name);
});
async function openSheet(page: Page, orderId: string) {
  await openOrders(page);
  const target = page.locator(".order-row").filter({ hasText: nm("만료") }).first();
  // 대상 주문을 DB 에서 식별하기 어려워 상태별로 하나씩 처리: 남은 pending 만료 주문 중 첫 행
  await target.getByTestId("expired-order-resolve-btn").click(); await expect(page.getByTestId("expired-order-sheet")).toBeVisible(); void orderId;
}
test("수납 여부 모름 — 닫기만 하면 주문·수강권·매출·이력 모두 변하지 않는다", async ({ page }, info) => {
  await loginManager(page); await openSheet(page, ord["모름"]);
  await page.getByTestId("expired-unknown").click(); await expect(page.getByTestId("expired-order-sheet")).toHaveCount(0);
  for (const k of ["미수납", "환불", "조정", "모름"]) expect(await status(k)).toBe("pending");
  expect(await cnt("memberships", "모름")).toBe(0);
  const all = (await svc.from("order_expiry_resolutions").select("id", { count: "exact", head: true }).in("order_id", Object.values(ord))).count ?? 0; expect(all).toBe(0);
  await shot(page, "02-unknown-closed", info.project.name);
});
const settle = async (before: string[], expectLeft = true) => { let left: string[] = []; await expect.poll(async () => { const now = await pendingExpired(); left = before.filter((i) => !now.includes(i)); return left.length; }, { timeout: 20_000 }).toBe(expectLeft ? 1 : 0); return left[0]; };
const pendingExpired = async () => (await svc.from("orders").select("id").eq("product_id", prod["만료"]).eq("status", "pending").order("created_at")).data?.map((r) => r.id) ?? [];
test("미수납 확인 → 주문 취소: cancelled, 수강권·결제 없음, 이력 1건", async ({ page }, info) => {
  await loginManager(page); await openSheet(page, ord["미수납"]);
  const before = await pendingExpired();
  await page.locator("#r-reason").fill("회원 확인 결과 입금 내역 없음"); await shot(page, "03-unpaid-sheet", info.project.name);
  await page.getByTestId("expired-unpaid-cancel").click();
  await confirmDialog(page);
  const target = await settle(before);
  expect((await svc.from("orders").select("status").eq("id", target).single()).data?.status).toBe("cancelled");
  expect((await svc.from("payments").select("id", { count: "exact", head: true }).eq("order_id", target)).count).toBe(0);
  expect((await svc.from("order_expiry_resolutions").select("resolution").eq("order_id", target).single()).data?.resolution).toBe("unpaid_cancelled");
  ord["미수납"] = target;
});
test("수납 확인 + 환불: 환불 예정(pending 유지·매출 없음) → 환불 완료 확인 → cancelled", async ({ page }, info) => {
  await loginManager(page); await openSheet(page, ord["환불"]);
  const before = await pendingExpired();
  await page.getByTestId("expired-paid").click();
  await page.locator("#r-amount").fill("80000"); await page.locator("#r-date").fill(kst(0)); await page.locator("#r-method").selectOption("cash");
  await page.getByRole("button", { name: "환불", exact: true }).click(); await page.locator("#r-reason2").fill("회원 요청으로 환불"); await shot(page, "04-refund-sheet", info.project.name);
  await page.getByTestId("expired-paid-submit").click();
  await confirmDialog(page);
  const planned = (await expect.poll(async () => (await svc.from("order_expiry_resolutions").select("order_id").eq("resolution", "refund_planned").in("order_id", before)).data?.length ?? 0, { timeout: 20_000 }).toBe(1), (await svc.from("order_expiry_resolutions").select("order_id").eq("resolution", "refund_planned").in("order_id", before)).data![0].order_id as string);
  const target = planned;
  expect((await svc.from("orders").select("status").eq("id", target).single()).data?.status).toBe("pending");
  expect((await svc.from("payments").select("id", { count: "exact", head: true }).eq("order_id", target)).count).toBe(0);
  await openOrders(page); await expect(page.getByTestId("expired-order-refund-planned")).toHaveCount(1); await shot(page, "05-refund-planned", info.project.name);
  await page.locator(".order-row").filter({ has: page.getByTestId("expired-order-refund-planned") }).getByTestId("expired-order-resolve-btn").click();
  await page.locator("#r-reason").fill("현금으로 전액 환불 완료");
  await page.getByRole("button", { name: "환불 완료 확인", exact: true }).last().click();
  await confirmDialog(page);
  await expect.poll(async () => (await svc.from("orders").select("status").eq("id", target).single()).data?.status, { timeout: 20_000 }).toBe("cancelled");
  expect((await svc.from("order_expiry_resolutions").select("resolution").eq("order_id", target).single()).data?.resolution).toBe("refund_completed");
  expect((await svc.from("payments").select("id", { count: "exact", head: true }).eq("order_id", target)).count).toBe(0);
  ord["환불"] = target;
});
test("수납 확인 + 이용기간 조정: 발급·매출 1건, 새 만료일 적용, 상품 만료일 불변", async ({ page }, info) => {
  await loginManager(page); await openSheet(page, ord["조정"]);
  const beforeIds = (await pendingExpired()).filter((i) => i !== ord["환불"]); const before = (await svc.from("products").select("expiry_date").eq("id", prod["만료"]).single()).data?.expiry_date;
  await page.getByTestId("expired-paid").click();
  await page.locator("#r-amount").fill("80000"); await page.locator("#r-date").fill(kst(0)); await page.locator("#r-method").selectOption("transfer");
  await page.locator("#r-expiry").fill(kst(45)); await page.locator("#r-reason2").fill("만료 전 입금 확인, 회원과 합의해 기간 조정"); await shot(page, "06-adjust-sheet", info.project.name);
  await page.getByTestId("expired-paid-submit").click();
  await confirmDialog(page);
  await expect.poll(async () => (await svc.from("orders").select("id").in("id", beforeIds).eq("status", "done")).data?.length ?? 0, { timeout: 20_000 }).toBe(1);
  const target = (await svc.from("orders").select("id").in("id", beforeIds).eq("status", "done")).data![0].id as string;
  expect((await svc.from("payments").select("id", { count: "exact", head: true }).eq("order_id", target)).count).toBe(1);
  const ms = (await svc.from("memberships").select("expires_at").eq("product_id", prod["만료"]).eq("profile_id", PROFILE)).data ?? [];
  expect(ms.length).toBe(1); expect(String(ms[0].expires_at).slice(0, 10)).toBe(kst(45));
  expect((await svc.from("products").select("expiry_date").eq("id", prod["만료"]).single()).data?.expiry_date).toBe(before);
  ord["조정"] = target; await shot(page, "07-after-adjust", info.project.name);
});
test("정상 주문은 일반 발급 흐름 그대로(회귀)", async ({ page }) => {
  await loginManager(page); await openOrders(page);
  const normal = page.locator(".order-row").filter({ hasText: nm("정상") });
  await normal.getByRole("button", { name: "확정 · 발급" }).click();
  await page.getByRole("button", { name: "계속하기", exact: true }).click();
  await expect.poll(async () => await status("정상"), { timeout: 20_000 }).toBe("done");
  expect((await svc.from("order_expiry_resolutions").select("id", { count: "exact", head: true }).eq("order_id", ord["정상"])).count).toBe(0);
});
void row; void rowOf;
