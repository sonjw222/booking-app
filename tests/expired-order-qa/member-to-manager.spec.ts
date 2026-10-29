import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";

/*
  만료 고정일 상품 — 회원 주문 생성(실제 UI) → 센터 관리자 /manager/orders 처리 E2E. 로컬 격리 스택 전용(데이터를 만든다): 가드가 로컬이 아니면 즉시 실패.
  운영에서는 QA 센터가 승인 대기 + 운영 QA 계정 없음으로 실행할 수 없어(BLOCKED) 같은 시나리오를 격리 스택에서 재현한다. "만료"는 상품 expiry_date 를 어제로 바꿔 만든다(격리 DB 한정).
  외부 결제·알림 없음(직접결제만). 스크린샷은 EXPIREDORDER_OUT/screenshots 에 `<번호>-isolated-<단계>-<viewport>.png` 로 저장.
*/
const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
let host = ""; try { host = new URL(URL_).hostname; } catch { /* */ }
if (!["127.0.0.1", "localhost"].includes(host)) throw new Error("ISOLATED_GUARD: 로컬 격리 Supabase 가 아니에요");
const need = (n: string) => { const v = process.env[n]; if (!v) throw new Error(`${n} 없음`); return v; };
const svc = createClient(URL_, need("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const psql = (sql: string) => execFileSync("docker", ["exec", "-i", "supabase_db_mwhabit-isolated", "psql", "-U", "postgres", "-At", "-v", "ON_ERROR_STOP=1", "-c", sql], { encoding: "utf8" }).trim();
const kst = (d = 0) => psql(`select to_char((now() at time zone 'Asia/Seoul')::date + ${d}, 'YYYY-MM-DD')`);
const tag = crypto.randomBytes(2).toString("hex"); const nm = (s: string) => `EXQA${tag}${s}`;
const shotDir = path.join(process.env.EXPIREDORDER_OUT ?? "test-results-expiredorderqa", "screenshots");
const shot = async (page: Page, n: string, step: string, project: string, full = false) => { fs.mkdirSync(shotDir, { recursive: true }); await page.screenshot({ path: path.join(shotDir, `${n}-isolated-${step}-${project}.png`), fullPage: full }); };
// 상품 목록 스크린샷 전/후 비교용: 같은 기준 행(정상 상품)을 화면 가운데로 스크롤해 만료 상품 행이 바로 위에 있는지(전) / 없는지(후)가 한눈에 보이게 한다. 화면 요소를 바꾸지 않고 스크롤만 한다.
const focusProductList = async (page: Page) => { const anchor = page.locator(".center-product-row").filter({ hasText: nm("정상") }); await anchor.evaluate((el) => el.scrollIntoView({ block: "center" })); await page.waitForTimeout(400); await expect(anchor).toBeInViewport(); };
const confirmDialog = async (page: Page) => { const b = page.getByRole("button", { name: /^(계속하기|확인)$/ }).last(); await b.waitFor({ state: "visible", timeout: 10_000 }); await b.click(); };
test.describe.configure({ mode: "serial" });
let OP = "", PROFILE = ""; const prod: Record<string, string> = {}; const ord: Record<string, string> = {}; const results: Record<string, string> = {};
const dbStatus = async (id: string) => (await svc.from("orders").select("status").eq("id", id).single()).data?.status as string;
const sbLogin = async (email: string, pw: string) => { const c = createClient(URL_, need("NEXT_PUBLIC_SUPABASE_ANON_KEY"), { auth: { persistSession: false } }); const { error } = await c.auth.signInWithPassword({ email, password: pw }); if (error) throw new Error(error.message); return c; };
async function login(page: Page, email: string, pw: string) {
  await page.goto("/login"); await page.locator('input[type="email"]').fill(email); await page.locator('input[type="password"]').fill(pw);
  await page.locator("button.login-submit").click(); await page.waitForURL("/", { timeout: 20_000 });
}
async function mkOrder(key: string, productKey: string) {
  const r = await svc.from("orders").insert({ center_id: OP, profile_id: PROFILE, product_id: prod[productKey], product_name: nm(productKey), amount: 80000, pay_method: "direct", status: "pending" }).select("id").single();
  if (r.error) throw new Error(r.error.message); ord[key] = r.data.id;
}
test.beforeAll(async () => {
  OP = (await svc.from("centers").select("id").eq("name", "[QA] 심사 시험 스튜디오").single()).data!.id;
  PROFILE = psql(`select p.id from profiles p join accounts a on a.id = p.account_id where a.auth_id = (select id from auth.users where email = '${need("TEST_USER_A_EMAIL")}') limit 1`);
  if (!PROFILE) throw new Error("회원 프로필 없음");
  // 매니저 A 를 격리 센터 오너로(격리 DB 한정). 새 일회용 스택(CI)에는 이 센터에 매니저 행이 아직 없으므로 없으면 만들고, 있으면 오너 역할·active 로 맞춘다.
  const mgrAcct = `(select a.id from accounts a where a.auth_id = (select id from auth.users where email = '${need("TEST_MANAGER_A_EMAIL")}'))`, ownerRole = `(select id from center_roles where center_id = '${OP}' and is_owner limit 1)`;
  psql(`update manager_centers set role_id = ${ownerRole}, status = 'active' where center_id = '${OP}' and account_id = ${mgrAcct}`);
  psql(`insert into manager_centers(account_id, center_id, role_id, status) select ${mgrAcct}, '${OP}', ${ownerRole}, 'active' where ${mgrAcct} is not null and not exists (select 1 from manager_centers where center_id = '${OP}' and account_id = ${mgrAcct})`);
  for (const [k, off] of [["만료", 1], ["정상", 30]] as const) {   // 만료 상품은 내일까지 판매 중으로 시작 — 회원이 UI 로 주문한 뒤 만료일을 어제로 바꾼다
    const r = await svc.from("products").insert({ center_id: OP, name: nm(k), price: 80000, product_kind: "pass", pass_type: "count", total_count: 5, is_active: true, is_on_sale: true, visibility_type: "all", expiry_mode: "date", expiry_date: kst(off) }).select("id").single();
    if (r.error) throw new Error(r.error.message); prod[k] = r.data.id;
  }
});
test.afterAll(async () => {
  const pl = Object.values(prod).map((i) => `'${i}'`).join(",");
  psql(`begin; set local session_replication_role = replica; delete from order_expiry_resolutions where order_id in (select id from orders where product_id in (${pl})); delete from payments where order_id in (select id from orders where product_id in (${pl})); delete from memberships where product_id in (${pl}); delete from orders where product_id in (${pl}); delete from products where id in (${pl}); commit;`);
  fs.mkdirSync(shotDir, { recursive: true }); fs.writeFileSync(path.join(shotDir, "..", `e2e-state-${test.info().project.name}.json`), JSON.stringify(results, null, 1));
});

test("M1 회원: 로그인 → 센터 상품 목록 → 구매(직접결제) → pending 주문 생성", async ({ page }, info) => {
  const p = info.project.name;
  await login(page, need("TEST_USER_A_EMAIL"), need("TEST_USER_A_PASSWORD")); await shot(page, "01", "member-after-login", p);
  await page.goto(`/center/${OP}?buy=1`); await page.waitForLoadState("networkidle");
  const row = page.locator(".center-product-row").filter({ hasText: nm("만료") });
  await expect(row).toBeVisible({ timeout: 20_000 }); await focusProductList(page); await expect(row).toBeInViewport(); await shot(page, "02", "member-center-product-list-before-expiry", p);
  await row.getByRole("button", { name: "구매" }).click();
  await page.waitForURL(/\/checkout/, { timeout: 20_000 }); await page.waitForLoadState("networkidle");
  await expect(page.getByText(nm("만료")).first()).toBeVisible(); await shot(page, "03", "member-checkout-product-detail", p, true);
  await page.locator(".pay-method", { hasText: "직접결제" }).click();
  await shot(page, "04", "member-order-direct-payment", p);
  const before = (await svc.from("orders").select("id").eq("product_id", prod["만료"])).data?.length ?? 0;
  await page.locator(".checkout-pay-btn").click();
  await expect.poll(async () => (await svc.from("orders").select("id").eq("product_id", prod["만료"])).data?.length ?? 0, { timeout: 20_000 }).toBe(before + 1);
  const o = (await svc.from("orders").select("id,status,pay_method").eq("product_id", prod["만료"]).single()).data!;
  expect(o.status).toBe("pending"); expect(o.pay_method).toBe("direct"); ord["UI"] = o.id;
  await page.waitForTimeout(800); await shot(page, "05", "member-order-created-pending", p, true);
  results.uiOrder = "pending/direct 생성됨(실제 UI 경로)";
});
test("M2 만료 후: 주문은 pending 유지 · 회원 목록에서 상품 사라짐 · 신규 주문 차단", async ({ page }, info) => {
  const p = info.project.name;
  for (const k of ["미수납", "환불", "조정", "모름"]) await mkOrder(k, "만료");   // 같은 만료 상품의 기존 pending 주문(요구 시나리오별 1건)
  await mkOrder("정상", "정상");
  psql(`update products set expiry_date = (now() at time zone 'Asia/Seoul')::date - 1 where id = '${prod["만료"]}'`);   // 격리 DB 한정: 판매 중 상품의 고정 만료일이 지난 상태를 만든다
  expect(await dbStatus(ord["UI"])).toBe("pending");
  await login(page, need("TEST_USER_A_EMAIL"), need("TEST_USER_A_PASSWORD"));
  await page.goto(`/center/${OP}?buy=1`); await page.waitForLoadState("networkidle");
  await expect(page.locator(".center-product-row").filter({ hasText: nm("정상") })).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".center-product-row").filter({ hasText: nm("만료") })).toHaveCount(0);
  await focusProductList(page); await shot(page, "06", "member-expired-product-gone-after-expiry", p);
  results.listHidden = "만료 상품이 센터 구매 목록에서 사라짐, 정상 상품은 표시";
  // 직접 URL 로 결제 화면에 들어가 주문 시도 → 신규 주문이 생기면 안 된다
  const cnt = async () => (await svc.from("orders").select("id", { count: "exact", head: true }).eq("product_id", prod["만료"])).count ?? 0;
  const before = await cnt();
  await page.goto(`/checkout?center=${OP}&product=${prod["만료"]}`); await page.waitForLoadState("networkidle"); await page.waitForTimeout(1500);
  await shot(page, "07", "member-expired-checkout-direct-url", p, true);
  const btn = page.locator(".checkout-pay-btn");
  if (await btn.count() && await btn.first().isEnabled()) { if (await page.locator(".pay-method", { hasText: "직접결제" }).count()) await page.locator(".pay-method", { hasText: "직접결제" }).click(); await btn.first().click(); await page.waitForTimeout(2500); }
  await shot(page, "08", "member-expired-order-blocked", p, true);
  expect(await cnt()).toBe(before);   // 신규 주문 차단
  // 서버 방어선: 회원 권한으로 직접 INSERT 도 거부
  const A = await sbLogin(need("TEST_USER_A_EMAIL"), need("TEST_USER_A_PASSWORD"));
  const ins = await A.from("orders").insert({ center_id: OP, profile_id: PROFILE, product_id: prod["만료"], product_name: nm("만료"), amount: 80000, pay_method: "direct", status: "pending" }).select("id");
  expect(ins.error, "만료 상품 직접 INSERT 는 거부되어야 함").not.toBeNull(); expect(await cnt()).toBe(before);
  results.newOrderBlocked = `UI·직접 URL·REST INSERT 모두 차단 (error=${ins.error?.message?.slice(0, 60)})`;
  await page.goto("/purchases"); await page.waitForLoadState("networkidle"); await page.waitForTimeout(1000);
  await shot(page, "09", "member-purchases-pending-state", p, true);
});
async function openOrders(page: Page) {
  await page.goto("/manager/orders"); await page.waitForLoadState("networkidle");
  const select = page.getByLabel("센터 선택");
  if (await select.count()) { if ((await select.first().inputValue()) !== OP) { await select.first().selectOption(OP); await page.waitForLoadState("networkidle"); } }
  await expect(page.getByText(nm("정상")).first()).toBeVisible({ timeout: 20_000 });
}
const loginManager = (page: Page) => login(page, need("TEST_MANAGER_A_EMAIL"), need("TEST_MANAGER_A_PASSWORD"));
const expiredRows = (page: Page) => page.locator(".order-row").filter({ hasText: nm("만료") });
const pendingExpired = async () => (await svc.from("orders").select("id").eq("product_id", prod["만료"]).eq("status", "pending").order("created_at")).data?.map((r) => r.id as string) ?? [];
async function openSheet(page: Page) { await openOrders(page); await expiredRows(page).first().getByTestId("expired-order-resolve-btn").click(); await expect(page.getByTestId("expired-order-sheet")).toBeVisible(); }

test("T1 관리자: 센터 홈 · 주문 목록 · 만료 경고 · 처리 버튼 · 일반 발급 버튼 없음", async ({ page }, info) => {
  const p = info.project.name;
  await loginManager(page); await page.goto("/manager"); await page.waitForLoadState("networkidle"); await page.waitForTimeout(1200); await shot(page, "10", "manager-center-home", p);
  await openOrders(page); await shot(page, "11", "manager-orders-list", p, true);
  await expect(page.getByTestId("expired-order-notice")).toHaveCount(5); await expect(page.getByTestId("expired-order-resolve-btn")).toHaveCount(5);
  await page.getByTestId("expired-order-notice").first().scrollIntoViewIfNeeded(); await shot(page, "12", "manager-expired-order-warning", p);
  await page.getByTestId("expired-order-resolve-btn").first().scrollIntoViewIfNeeded(); await shot(page, "13", "manager-handle-button", p);
  await expect(expiredRows(page).getByRole("button", { name: "확정 · 발급" })).toHaveCount(0);
  const normal = page.locator(".order-row").filter({ hasText: nm("정상") });
  await expect(normal.getByRole("button", { name: "확정 · 발급" })).toBeVisible(); await expect(normal.getByTestId("expired-order-notice")).toHaveCount(0);
  results.managerWarning = "만료 주문 5건 경고+처리 버튼, 일반 발급 버튼 없음; 정상 주문은 기존 버튼";
});
test("T2 수납 여부 모름 → 닫기만: pending 유지, 변경 없음", async ({ page }, info) => {
  const p = info.project.name;
  await loginManager(page); await openSheet(page); await shot(page, "14", "manager-method-sheet", p);
  await page.getByTestId("expired-unknown").click(); await expect(page.getByTestId("expired-order-sheet")).toHaveCount(0);
  for (const k of ["UI", "미수납", "환불", "조정", "모름"]) expect(await dbStatus(ord[k])).toBe("pending");
  expect((await svc.from("order_expiry_resolutions").select("id", { count: "exact", head: true }).in("order_id", Object.values(ord))).count).toBe(0);
  expect((await svc.from("memberships").select("id", { count: "exact", head: true }).eq("product_id", prod["만료"])).count).toBe(0);
  results.unknown = "pending 유지, 수강권·이력 변화 없음";
});
test("T3 미수납 확인 → 주문 취소 → cancelled", async ({ page }, info) => {
  const p = info.project.name;
  await loginManager(page); await openSheet(page); const before = await pendingExpired();
  await page.locator("#r-reason").fill("회원 확인 결과 입금 내역 없음"); await shot(page, "15", "manager-unpaid-cancel-confirm-sheet", p);
  await page.getByTestId("expired-unpaid-cancel").click(); await page.getByRole("button", { name: /^(계속하기|확인)$/ }).last().waitFor({ state: "visible" }); await shot(page, "16", "manager-unpaid-cancel-confirm-dialog", p);
  await confirmDialog(page);
  let target = ""; await expect.poll(async () => { const now = await pendingExpired(); target = before.find((i) => !now.includes(i)) ?? ""; return target !== ""; }, { timeout: 20_000 }).toBe(true);
  expect(await dbStatus(target)).toBe("cancelled");
  expect((await svc.from("payments").select("id", { count: "exact", head: true }).eq("order_id", target)).count).toBe(0);
  expect((await svc.from("order_expiry_resolutions").select("resolution").eq("order_id", target).single()).data?.resolution).toBe("unpaid_cancelled");
  await page.waitForTimeout(800); await shot(page, "17", "manager-unpaid-cancel-result", p); results.unpaidCancel = `cancelled(${target.slice(0, 8)}), 결제 0, 이력 unpaid_cancelled`; ord["취소됨"] = target;
});
test("T4 수납 확인 + 환불: 환불 예정(pending·이력) → 환불 완료 → cancelled + 기록", async ({ page }, info) => {
  const p = info.project.name;
  await loginManager(page); await openSheet(page); const before = await pendingExpired();
  await page.getByTestId("expired-paid").click();
  await page.locator("#r-amount").fill("80000"); await page.locator("#r-date").fill(kst(0)); await page.locator("#r-method").selectOption("cash");
  await page.getByRole("button", { name: "환불", exact: true }).click(); await page.locator("#r-reason2").fill("회원 요청으로 환불"); await shot(page, "18", "manager-refund-plan-sheet", p);
  await page.getByTestId("expired-paid-submit").click(); await confirmDialog(page);
  await expect.poll(async () => (await svc.from("order_expiry_resolutions").select("order_id").eq("resolution", "refund_planned").in("order_id", before)).data?.length ?? 0, { timeout: 20_000 }).toBe(1);
  const target = (await svc.from("order_expiry_resolutions").select("order_id").eq("resolution", "refund_planned").in("order_id", before)).data![0].order_id as string;
  expect(await dbStatus(target)).toBe("pending"); expect((await svc.from("payments").select("id", { count: "exact", head: true }).eq("order_id", target)).count).toBe(0);
  await openOrders(page); await expect(page.getByTestId("expired-order-refund-planned")).toHaveCount(1); await shot(page, "19", "manager-refund-planned-state", p);
  await page.locator(".order-row").filter({ has: page.getByTestId("expired-order-refund-planned") }).getByTestId("expired-order-resolve-btn").click();
  await page.locator("#r-reason").fill("현금으로 전액 환불 완료"); await shot(page, "20", "manager-refund-complete-sheet", p);
  await page.getByRole("button", { name: "환불 완료 확인", exact: true }).last().click(); await confirmDialog(page);
  await expect.poll(async () => dbStatus(target), { timeout: 20_000 }).toBe("cancelled");
  expect((await svc.from("order_expiry_resolutions").select("resolution").eq("order_id", target).single()).data?.resolution).toBe("refund_completed");
  expect((await svc.from("payments").select("id", { count: "exact", head: true }).eq("order_id", target)).count).toBe(0);
  await page.waitForTimeout(800); await shot(page, "21", "manager-refund-complete-result", p); results.refund = "환불 예정 pending+이력 → 환불 완료 cancelled+기록, 결제/매출 0"; ord["환불됨"] = target;
});
test("T5 수납 확인 + 이용기간 조정 → 새 만료일 수강권 발급", async ({ page }, info) => {
  const p = info.project.name;
  await loginManager(page); await openSheet(page); const ids = await pendingExpired();
  const before = (await svc.from("products").select("expiry_date").eq("id", prod["만료"]).single()).data?.expiry_date;
  await page.getByTestId("expired-paid").click();
  await page.locator("#r-amount").fill("80000"); await page.locator("#r-date").fill(kst(0)); await page.locator("#r-method").selectOption("transfer");
  await page.locator("#r-expiry").fill(kst(45)); await page.locator("#r-reason2").fill("만료 전 입금 확인, 회원과 합의해 기간 조정"); await shot(page, "22", "manager-adjust-period-sheet", p);
  await page.getByTestId("expired-paid-submit").click(); await confirmDialog(page);
  await expect.poll(async () => (await svc.from("orders").select("id").in("id", ids).eq("status", "done")).data?.length ?? 0, { timeout: 20_000 }).toBe(1);
  const target = (await svc.from("orders").select("id").in("id", ids).eq("status", "done")).data![0].id as string;
  expect((await svc.from("payments").select("id", { count: "exact", head: true }).eq("order_id", target)).count).toBe(1);
  const ms = (await svc.from("memberships").select("expires_at").eq("product_id", prod["만료"]).eq("profile_id", PROFILE)).data ?? [];
  expect(ms.length).toBe(1); expect(String(ms[0].expires_at).slice(0, 10)).toBe(kst(45));
  expect((await svc.from("products").select("expiry_date").eq("id", prod["만료"]).single()).data?.expiry_date).toBe(before);
  await page.waitForTimeout(800); await shot(page, "23", "manager-adjust-period-result", p); results.adjust = `done, 결제 1건, 수강권 만료일 ${kst(45)}, 상품 만료일 불변`; ord["조정됨"] = target;
});
test("T6 우회 차단: 일반 발급 RPC·주문 직접 수정·미수납 위장 모두 서버 거부, 정상 상품 주문은 일반 흐름", async ({ page }, info) => {
  const p = info.project.name;
  const M = await sbLogin(need("TEST_MANAGER_A_EMAIL"), need("TEST_MANAGER_A_PASSWORD"));
  const left = await pendingExpired(); expect(left.length).toBeGreaterThan(0); const id = left[0];
  const f = await M.rpc("fulfill_order", { p_order_id: id }); expect(f.error, "만료 주문 일반 발급(fulfill_order) 은 가드 차단").not.toBeNull();
  const u1 = await M.from("orders").update({ status: "cancelled" }).eq("id", id).select("id"); const s1 = await dbStatus(id);
  const u2 = await M.from("orders").update({ amount: 1 }).eq("id", id).select("id"); const a2 = (await svc.from("orders").select("amount").eq("id", id).single()).data?.amount;
  const u3 = await M.from("orders").update({ status: "done" }).eq("id", id).select("id");
  expect(s1).toBe("pending"); expect(a2).toBe(80000); expect(await dbStatus(id)).toBe("pending");
  expect([u1, u2, u3].every((r) => r.error != null || (r.data ?? []).length === 0)).toBe(true);
  expect((await svc.from("memberships").select("id", { count: "exact", head: true }).eq("product_id", prod["만료"])).count).toBe(1);   // T5 의 정상 조정 발급 1건뿐
  results.bypass = `fulfill_order 거부(${f.error?.message?.slice(0, 50)}), 직접 UPDATE(status/amount) 불변`;
  await loginManager(page); await openOrders(page);
  const normal = page.locator(".order-row").filter({ hasText: nm("정상") });
  await shot(page, "24", "manager-normal-order-before", p);
  await normal.getByRole("button", { name: "확정 · 발급" }).click(); await page.getByRole("button", { name: "계속하기", exact: true }).click();
  await expect.poll(async () => dbStatus(ord["정상"]), { timeout: 20_000 }).toBe("done");
  expect((await svc.from("order_expiry_resolutions").select("id", { count: "exact", head: true }).eq("order_id", ord["정상"])).count).toBe(0);
  await page.waitForTimeout(800); await shot(page, "25", "manager-normal-order-issued", p); results.normal = "일반 상품 주문은 기존 확정·발급 흐름으로 done, 이력 0";
});
