import fs from "node:fs";
import path from "node:path";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/* 관리자 QA(#239) 공통 헬퍼 — 로컬 격리 스택 전용.
   가드: NEXT_PUBLIC_SUPABASE_URL 이 로컬(127.0.0.1/localhost)이 아니면 모든 테스트가 시작 전에 실패한다(공유 DEV·운영으로 데이터 변경 불가). */

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
export function assertLocalIsolated(): void {
  let host = ""; try { host = new URL(url).hostname; } catch { /* 형식 오류 */ }
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(host)) throw new Error("ISOLATED_GUARD: 로컬 격리 Supabase 가 아니에요 — 관리자 QA 는 데이터를 변경하므로 중단합니다");
}
assertLocalIsolated();

export const need = (n: string): string => { const v = process.env[n]; if (!v) throw new Error(`환경변수 ${n} 없음 — scripts/isolated/adminQa/seedAdminQa.mjs 를 먼저 실행하세요`); return v; };
export const QA_CENTER_ID = () => need("QA_CENTER_ID");
export function db(): SupabaseClient { return createClient(url, need("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } }); }

export type Role = "owner" | "allowed" | "limited" | "member" | "platform";
const CREDS: Record<Role, () => [string, string]> = {
  owner: () => [need("TEST_MANAGER_A_EMAIL"), need("TEST_MANAGER_A_PASSWORD")],
  allowed: () => [need("QA_ALLOWED_EMAIL"), need("QA_ALLOWED_PASSWORD")],
  limited: () => [need("QA_LIMITED_EMAIL"), need("QA_LIMITED_PASSWORD")],
  member: () => [need("TEST_USER_A_EMAIL"), need("TEST_USER_A_PASSWORD")],
  platform: () => [need("TEST_PLATFORM_ADMIN_EMAIL"), need("TEST_PLATFORM_ADMIN_PASSWORD")],
};
const authDir = path.resolve(process.cwd(), "test-results-adminqa/.auth");

/* 역할별 로그인 세션(storageState)을 한 번만 만든다. 같은 계정으로 다시 로그인하면 이전 세션이 무효화될 수 있으므로(auth.setup.ts 주석) 계정당 1회만 폼 로그인한다. */
export async function sessionFor(browser: Browser, role: Role): Promise<string> {
  const file = path.join(authDir, `${role}.json`);
  if (fs.existsSync(file)) return file;
  fs.mkdirSync(authDir, { recursive: true });
  const ctx = await browser.newContext(); const page = await ctx.newPage();
  const [email, password] = CREDS[role]();
  await page.goto("/login");
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.locator("button.login-submit").click();
  await page.waitForURL("/", { timeout: 20_000 });
  await ctx.storageState({ path: file }); await ctx.close();
  return file;
}
export async function openAs(browser: Browser, role: Role): Promise<{ ctx: BrowserContext; page: Page; errors: string[] }> {
  const ctx = await browser.newContext({ storageState: await sessionFor(browser, role), viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage(); const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  return { ctx, page, errors };
}

const shotDir = process.env.ADMINQA_OUT ? path.join(process.env.ADMINQA_OUT, "screenshots") : "test-results-adminqa/screenshots";
export async function shot(page: Page, name: string): Promise<void> { fs.mkdirSync(shotDir, { recursive: true }); await page.screenshot({ path: path.join(shotDir, `${name}.png`), fullPage: false }); }

export async function gotoQaCenter(page: Page, pathName: string): Promise<void> {
  await page.goto(pathName);
  await page.waitForLoadState("networkidle");
  const select = page.getByLabel("센터 선택");
  if (await select.count()) { if ((await select.first().inputValue()) !== QA_CENTER_ID()) { await select.first().selectOption(QA_CENTER_ID()); await page.waitForLoadState("networkidle"); } }
}
export const kstDate = (offsetDays = 0): string => { const d = new Date(Date.now() + offsetDays * 86400000 + 9 * 3600000); return d.toISOString().slice(0, 10); };
export const uniq = (p: string) => `${p}-${Math.random().toString(36).slice(2, 7)}`;
export { expect, test };

/* QA 센터·fixture 회원의 수강권·결제·예약을 비운다(서비스 롤 — 격리 DB 한정, 이전 실행 잔여 제거). 실패해도 테스트는 계속한다. */
export async function resetQaMember(): Promise<void> {
  const d = db(); const profile = need("QA_MEMBER_PROFILE_ID"); const center = QA_CENTER_ID();
  const ms = (await d.from("memberships").select("id").eq("center_id", center).eq("profile_id", profile)).data ?? [];
  const ids = ms.map((m) => m.id);
  await d.from("reservations").delete().eq("profile_id", profile).in("class_id", ((await d.from("classes").select("id").eq("center_id", center)).data ?? []).map((c) => c.id));
  if (ids.length) {
    for (const [t, c] of [["admin_action_logs", "membership_id"], ["payments", "membership_id"]] as const) { const r = await d.from(t).delete().in(c, ids); if (r.error) throw new Error(`reset ${t}: ${r.error.message}`); }
    const r = await d.from("memberships").delete().in("id", ids); if (r.error) throw new Error(`reset memberships: ${r.error.message}`);
  }
  await d.from("orders").delete().eq("center_id", center).eq("profile_id", profile);
}

/* 브라우저 세션의 액세스 토큰으로 PostgREST/RPC 를 직접 호출한다(UI 를 우회한 서버 거부 확인용). 서비스 롤을 쓰지 않는다. */
export async function sessionToken(page: Page): Promise<string> {
  const raw = await page.evaluate(() => { const k = Object.keys(localStorage).find((x) => x.includes("auth-token")); return k ? localStorage.getItem(k) : null; });
  if (!raw) throw new Error("로그인 세션 토큰을 찾지 못했어요");
  return (JSON.parse(raw) as { access_token: string }).access_token;
}
export function restAs(page: Page) {
  const anon = need("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  const call = async (method: "POST" | "PATCH" | "DELETE" | "GET", pathName: string, body?: unknown) => {
    const token = await sessionToken(page);
    const res = await page.request.fetch(`${url}/rest/v1/${pathName}`, { method, headers: { apikey: anon, Authorization: `Bearer ${token}`, "Content-Type": "application/json", Prefer: "return=representation" }, data: body === undefined ? undefined : JSON.stringify(body) });
    let json: unknown = null; try { json = await res.json(); } catch { /* 본문 없음 */ }
    return { status: res.status(), json };
  };
  return { post: (p: string, b: unknown) => call("POST", p, b), patch: (p: string, b: unknown) => call("PATCH", p, b), del: (p: string) => call("DELETE", p), get: (p: string) => call("GET", p), rpc: (fn: string, b: unknown) => call("POST", `rpc/${fn}`, b) };
}
/* 서버가 막았는지: 4xx(권한/RLS) 이거나, 2xx 인데 변경된 행이 0(RLS 로 조용히 걸러짐) */
export const denied = (r: { status: number; json: unknown }) => r.status >= 400 || (Array.isArray(r.json) && r.json.length === 0);
