import { test, expect, openAs, db, QA_CENTER_ID, gotoQaCenter, shot, need, sessionToken } from "./helpers";
import type { BrowserContext, Page } from "@playwright/test";

/* [센터 오너] 알림톡 발송 UI(외부 전송은 요청 가로채기 모킹 — 실제 알리고 호출 0건), 역할별 권한 변경, 직원 역할 지정. */
test.describe.configure({ mode: "serial" });
let ctx: BrowserContext; let page: Page; let errors: string[];
test.beforeAll(async ({ browser }) => { ({ ctx, page, errors } = await openAs(browser, "owner")); });
test.afterAll(async () => { await ctx.close(); });

test("[오너] 알림톡 발송 UI — 수신자 선택 → 템플릿 → 발송(send-alimtalk 요청은 모킹, 외부 호출 0건)", async () => {
  const external: string[] = []; const sent: Array<Record<string, unknown>> = [];
  page.on("request", (r) => { const h = new URL(r.url()).hostname; if (!["localhost", "127.0.0.1"].includes(h)) external.push(h); });
  // 격리 앱 서버의 기본 메시지 제공자는 mock(NEXT_PUBLIC_MESSAGE_PROVIDER 미설정) — 어떤 외부 전송도 일어나지 않는다. 그래도 혹시 send-alimtalk 호출이 있으면 가로채 기록한다(실서비스 제공자 설정 시 모킹 보장).
  await page.route("**/functions/v1/send-alimtalk", async (route) => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, x-client-info, apikey, content-type", "access-control-allow-methods": "POST, OPTIONS" } });
    try { sent.push(route.request().postDataJSON()); } catch { sent.push({ raw: route.request().postData() }); }
    await route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ ok: true, mocked: true }) });
  });
  await gotoQaCenter(page, "/manager/alimtalk/send");
  await page.getByRole("checkbox", { name: "CI User A 선택" }).check();
  await page.getByRole("button", { name: "1명에게 알림톡 보내기" }).click();
  await page.locator("select").last().selectOption({ label: "QA 안내" });
  await expect(page.locator("textarea")).not.toHaveValue("");
  await page.locator('input[placeholder="name"]').fill("QA회원");   // 자동으로 알 수 없는 템플릿 변수는 직접 입력해야 발송 버튼이 켜진다
  await shot(page, "05-alimtalk-compose");
  await page.getByRole("button", { name: "발송", exact: true }).click();
  await expect(page.getByText(/발송|전송|보냈/).filter({ hasText: /완료|성공|1명|보냈/ }).first()).toBeVisible({ timeout: 15_000 });
  await shot(page, "05-alimtalk-sent");
  test.info().annotations.push({ type: "observed", description: `send-alimtalk 가로챈 요청 ${sent.length}건(mock 제공자면 0건), 외부 호스트 요청 ${external.length}건` });
  expect(external, "외부(비로컬) 호스트 요청이 없어야 한다").toEqual([]);
  expect(errors).toEqual([]);
});

test("[오너] 역할별 권한 변경 — 'QA 변경 대상' 역할에 룸 조회 권한 부여 → role_permissions 행", async () => {
  const roleId = need("QA_TARGET_ROLE_ID");
  await db().from("role_permissions").delete().eq("role_id", roleId).eq("permission_key", "facility.room.view");
  await gotoQaCenter(page, "/manager/staff");
  await page.getByRole("button", { name: "역할별 권한" }).click();
  await page.getByRole("button", { name: "QA 변경 대상" }).click();
  await shot(page, "05-role-perms-before");
  const row = page.getByText("룸 조회", { exact: true }).first().locator("xpath=ancestor::*[.//input[@type='checkbox']][1]");
  await row.locator("input[type=checkbox]").first().click({ force: true });
  await shot(page, "05-role-perms-dirty");
  await page.getByRole("button", { name: "저장", exact: true }).click();
  await expect(page.getByText("저장됨")).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => (await db().from("role_permissions").select("id").eq("role_id", roleId).eq("permission_key", "facility.room.view")).data?.length, { timeout: 15_000 }).toBe(1);
  await shot(page, "05-role-perms-after");
});

test("[오너] 직원 역할 변경 — 직원 상세에서 'QA 조회 전용' 역할 지정 → manager_centers.role_id 반영(원복 포함)", async () => {
  const targetAcc = need("QA_TARGET_ACCOUNT_ID"); const origRole = need("QA_TARGET_ROLE_ID");
  const limitedRole = (await db().from("center_roles").select("id").eq("center_id", QA_CENTER_ID()).eq("name", "QA 조회 전용").single()).data!.id;
  const roleOf = async () => (await db().from("manager_centers").select("role_id").eq("account_id", targetAcc).eq("center_id", QA_CENTER_ID()).single()).data?.role_id;
  await gotoQaCenter(page, "/manager/staff");
  await page.getByText("QA 변경대상직원", { exact: true }).first().click();
  await expect(page.getByText("현재 역할")).toBeVisible();
  await shot(page, "05-staff-detail");
  await page.getByRole("button", { name: "QA 조회 전용", exact: true }).last().click();
  const ok = page.getByRole("button", { name: /^(확인|계속하기)$/ }); if (await ok.count()) await ok.first().click();
  await expect.poll(roleOf, { timeout: 15_000 }).toBe(limitedRole);
  await shot(page, "05-staff-role-changed");
  await db().from("manager_centers").update({ role_id: origRole }).eq("account_id", targetAcc).eq("center_id", QA_CENTER_ID());   // 원복(서비스 롤 — QA fixture)
  expect(await roleOf()).toBe(origRole);
});

test("[오너] 알림톡 서버 권한 — 오너 JWT 는 send-alimtalk 권한 검사를 통과(외부 알리고 미연동이라 502 까지만 진행)", async () => {
  await gotoQaCenter(page, "/manager/alimtalk/send");
  const token = await sessionToken(page);
  const res = await page.request.fetch(`${need("NEXT_PUBLIC_SUPABASE_URL")}/functions/v1/send-alimtalk`, { method: "POST", headers: { apikey: need("NEXT_PUBLIC_SUPABASE_ANON_KEY"), Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, data: JSON.stringify({ to: "01099999999", content: "QA 권한 확인(외부 자격증명 없음 — 실제 발송 불가)", channel: "alimtalk", centerId: QA_CENTER_ID() }) });
  expect([401, 403], `오너는 권한 검사에서 막히면 안 됨(${res.status()})`).not.toContain(res.status());
});
