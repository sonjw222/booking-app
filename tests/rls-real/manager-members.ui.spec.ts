/* UX-14 — 관리자 회원 화면(실제 브라우저)을 격리 PostgREST의 실제 데이터로 확인한다. 어떤 줄이 실제 데이터이고 어떤 줄이 응답 조작(mock)인지 테스트 이름에 표시한다. */
import { createHmac } from "node:crypto";
import fs from "node:fs";
import { expect, test, type Page } from "@playwright/test";

const SECRET = "qa-secret-qa-secret-qa-secret-1234567890";
const b = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (sub: string) => { const h = b({ alg: "HS256", typ: "JWT" }), p = b({ role: "authenticated", iss: "qa", exp: 4102444800, sub, aud: "authenticated" }); return `${h}.${p}.${createHmac("sha256", SECRET).update(`${h}.${p}`).digest("base64url")}`; };
const MANAGER = "33333333-3333-3333-3333-333333333333";
const SHOTS = process.env.SHOTS_DIR;

async function loginAsManager(page: Page) {
  const token = jwt(MANAGER);
  await page.addInitScript((t) => {
    const exp = Math.floor(Date.now() / 1000) + 3600 * 24;
    localStorage.setItem("sb-127-auth-token", JSON.stringify({ access_token: t, refresh_token: "r", expires_at: exp, expires_in: 86400, token_type: "bearer", user: { id: "33333333-3333-3333-3333-333333333333", aud: "authenticated", email: "m@test.invalid", app_metadata: { provider: "email" }, user_metadata: {} } }));
  }, token);
}
const rowOf = (page: Page, name: string) => page.locator(".mem-row", { hasText: name });
async function shot(page: Page, name: string, theme: string) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme); await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-${theme === "light" ? "light" : "dark"}-${name}.png` });
}

test("[실제 데이터] 전화번호 없는 앱 연결 회원·가족 프로필·번호 있는 회원: 목록과 상세 문구가 일치한다", async ({ page }) => {
  await loginAsManager(page);
  await page.goto("/manager/members");
  await expect(page.locator(".mem-row").first()).toBeVisible({ timeout: 30_000 });
  // 목록: 전화번호 없음 ≠ 앱 계정 미연결
  for (const name of ["일반회원A", "자녀A"]) {
    const r = rowOf(page, name);
    await expect(r, `${name} 행`).toBeVisible();
    await expect(r).toContainText("전화번호 없음");
    await expect(r).not.toContainText("앱 계정 미연결");
    await expect(r).not.toContainText("앱 미연결");
  }
  const b1 = rowOf(page, "일반회원B");
  await expect(b1).toContainText("01022223333");
  await expect(b1).not.toContainText("전화번호 없음");
  await expect(b1).not.toContainText("미연결");
  await shot(page, "members-list", "light"); await shot(page, "members-list", "charcoal");
  // 상세: 같은 상태가 같은 말로 보인다
  for (const [name, phone] of [["일반회원A", "전화번호 없음"], ["자녀A", "전화번호 없음"], ["일반회원B", "01022223333"]] as const) {
    await rowOf(page, name).click();
    const detail = page.locator(".sheet", { hasText: "앱연결" });
    await expect(detail).toBeVisible();
    await expect(detail.locator(".admin-row", { hasText: "앱연결" })).toContainText("앱 계정 연결됨");
    await expect(detail.locator(".admin-row", { hasText: "전화" }).first()).toContainText(phone);
    if (name === "일반회원A") { await shot(page, "member-detail", "light"); await shot(page, "member-detail", "charcoal"); }
    await page.keyboard.press("Escape");
    await page.locator(".sheet-overlay").click({ position: { x: 5, y: 5 }, timeout: 2000 }).catch(() => {});
  }
});

test("[응답 조작(mock)] 프로필이 앱 계정을 가리키지 않는 회원(스키마상 실제 데이터로는 만들 수 없는 상태): 목록·상세 모두 '앱 계정 미연결'", async ({ page }) => {
  await loginAsManager(page);
  await page.route("**/rest/v1/center_members*", async (route) => {
    const res = await route.fetch();
    const rows = (await res.json()) as { profiles?: { name?: string; account_id?: string | null; accounts?: unknown }[] | { name?: string; account_id?: string | null; accounts?: unknown } }[];
    for (const r of rows) { const p = Array.isArray(r.profiles) ? r.profiles[0] : r.profiles; if (p?.name === "일반회원B") { p.account_id = null; p.accounts = null; (r as { app_linked?: boolean }).app_linked = false; } }
    await route.fulfill({ response: res, json: rows });
  });
  await page.goto("/manager/members");
  await expect(page.locator(".mem-row").first()).toBeVisible({ timeout: 30_000 });
  const unlinked = rowOf(page, "일반회원B");
  await expect(unlinked).toContainText("앱 계정 미연결");
  await expect(rowOf(page, "일반회원A")).not.toContainText("미연결");
  await unlinked.click();
  await expect(page.locator(".admin-row", { hasText: "앱연결" })).toContainText("앱 계정 미연결");
  await shot(page, "member-unlinked-mock", "light");
});
