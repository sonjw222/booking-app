/* 관리자 센터 페이지네이션(PR #196) 실제 브라우저 검증 — 격리 PostgreSQL + PostgREST + 실제 JWT(플랫폼 관리자 계정은 격리 DB 안에서만 만든다). 공유 DEV/운영 접속 없음.
   기능 플래그 ON(`NEXT_PUBLIC_ADMIN_CENTER_PAGINATION=true`)과 OFF(미설정)를 서로 다른 dev 서버(포트)로 실행한다:
     ON : UI_RLS_PORT=3311 NEXT_PUBLIC_ADMIN_CENTER_PAGINATION=true playwright test -c playwright.rlsui.config.ts tests/rls-real/adminPagination.ui.spec.ts --project=desktop-chromium
     OFF: UI_RLS_PORT=3312 playwright test … (같은 명령, 플래그 없음)
   상태별 데이터: 승인대기 31(30/31 경계 + 같은 created_at 동률 5건), 승인됨 30(정확히 30), 반려됨 61(3페이지: 30+30+1). 서버 정렬 기준 = created_at DESC, id DESC.
   순수 검증 규칙(경계·중복/누락·커서 연속성)은 tests/e2e/fixtures/adminPaginationVerify.ts(오프라인 단위 테스트가 먼저 검증)를 그대로 쓴다.
   '응답 지연/역전'은 실제 서버 응답을 라우트로 지연시키는 조작(mock)이며 이름에 표시한다. 일반 센터 오너의 운영 UI QA 는 이 검증의 증거가 아니다. */
import { expect, test, type Page } from "@playwright/test";
import { PAGE_SIZE, verifyTabPagination, type PageCall } from "../e2e/fixtures/adminPaginationVerify";
import { sql, U } from "./support";
import { loginAs } from "./uiLogin";

const FLAG_ON = process.env.NEXT_PUBLIC_ADMIN_CENTER_PAGINATION === "true";
const ADMIN = "66666666-6666-6666-6666-666666666666";
const PFX = "QA페이지";
const TABS = [["승인대기", "pending", 31], ["승인됨", "approved", 30], ["반려됨", "rejected", 61]] as const;

function cleanCenters() {
  const ids = `select id from centers where name like '${PFX}%'`;
  sql(`delete from role_permissions where role_id in (select id from center_roles where center_id in (${ids}))`);
  sql(`delete from center_roles where center_id in (${ids})`); sql(`delete from center_settings where center_id in (${ids})`);
  sql(`delete from centers where name like '${PFX}%'`);
}

test.beforeAll(() => {
  sql(`insert into auth.users(id,email) values ('${ADMIN}','platform@test.invalid') on conflict do nothing`);
  sql(`insert into accounts(id,auth_id,name,is_platform_admin) values ('d6600000-0000-0000-0000-0000000000d6','${ADMIN}','격리 플랫폼 관리자',true) on conflict (id) do update set is_platform_admin=true`);
  cleanCenters();
  for (const [, status, target] of TABS) {
    const existing = Number(sql(`select count(*) from centers where status='${status}'`));   // 시드의 기존 센터(공개 스튜디오 등)도 목록에 나오므로 합계가 정확히 목표가 되게 만든다
    const n = target - existing;
    // created_at: 1분 간격 + 앞 5건은 정확히 같은 시각(동률 → id 로 정렬되는 커서 경계)
    sql(`insert into centers(name,status,address,created_at) select '${PFX}-${status}-' || lpad(g::text,3,'0'), '${status}', '격리 주소 ' || g, case when g <= 5 then timestamptz '2026-10-01 09:00+09' else timestamptz '2026-10-01 09:00+09' + (g || ' minutes')::interval end from generate_series(1,${n}) g`);
  }
});
test.afterAll(() => {
  cleanCenters();
  sql(`delete from profiles where account_id='d6600000-0000-0000-0000-0000000000d6'`); sql(`delete from accounts where id='d6600000-0000-0000-0000-0000000000d6'`); sql(`delete from auth.users where id='${ADMIN}'`);
});

const expectedIds = (status: string) => sql(`select id from centers where status='${status}' order by created_at desc, id desc`).split("\n");

function trackPages(page: Page) {
  const calls: PageCall[] = []; const pending: Promise<void>[] = [];
  const slots = new Map<unknown, PageCall>();
  page.on("request", (req) => {
    if (!/\/rest\/v1\/rpc\/admin_list_centers_page/.test(req.url())) return;
    let body: PageCall["body"] = {}; try { body = req.postDataJSON() ?? {}; } catch { /* body 없음 */ }
    const c: PageCall = { ids: [], body, status: 0 }; calls.push(c); slots.set(req, c);
  });
  page.on("response", (res) => {
    const c = slots.get(res.request()); if (!c) return; c.status = res.status();
    pending.push((async () => { try { c.ids = ((await res.json()) as { id: string }[]).map((r) => r.id); } catch { /* 오류 응답 */ } })());
  });
  return { calls, flush: () => Promise.all(pending) };
}
const domIds = (page: Page) => page.locator("[data-center-id]").evaluateAll((els) => els.map((e) => e.getAttribute("data-center-id")!));
async function openAdmin(page: Page) {
  await loginAs(page, ADMIN, "platform@test.invalid");
  await page.goto("/admin/centers");
  await expect(page.getByText("센터 승인 관리")).toBeVisible({ timeout: 30_000 });
}
async function selectTab(page: Page, label: string) { await page.locator(".center-chip", { hasText: label }).first().click(); }
const search = (page: Page) => page.getByPlaceholder("센터명, 대표자, 주소, 전화번호로 검색");

for (const [label, status, n] of TABS) {
  test(`[플래그 ${FLAG_ON ? "ON" : "OFF"}] ${label} ${n}건: 30개 단위 더 보기, 경계·중복·누락·순서(created_at DESC, id DESC)`, async ({ page }) => {
    const t = trackPages(page);
    await openAdmin(page);
    if (status !== "pending") await selectTab(page, label);
    await expect(page.locator("[data-center-id]").first()).toBeVisible({ timeout: 30_000 });
    const more = page.getByRole("button", { name: "센터 더 보기" });
    expect(await page.locator("[data-center-id]").count(), "첫 페이지는 30개").toBe(Math.min(n, PAGE_SIZE));
    let guard = 0;
    while (await more.count() && guard++ < 10) { const before = await page.locator("[data-center-id]").count(); await more.click(); await expect.poll(() => page.locator("[data-center-id]").count(), { timeout: 15_000 }).toBeGreaterThan(before); }
    const dom = await domIds(page); const expected = expectedIds(status);
    expect(dom.length, `${label} 전체 표시 수`).toBe(n);
    expect(new Set(dom).size, "중복 없음").toBe(n);
    expect(dom, "서버(DB) 정렬 순서와 화면 순서가 같다").toEqual(expected);
    expect(await more.count(), "마지막 페이지에서는 더 보기 없음").toBe(0);
    if (FLAG_ON) {
      await t.flush();
      const own = t.calls.filter((c) => c.body.p_status === status);
      const v = verifyTabPagination({ calls: own, domIds: dom, moreButtonVisibleAtEnd: false });
      expect(v.problems, v.problems.join(" | ")).toEqual([]);
      expect(v.pages).toBe(Math.ceil(n / PAGE_SIZE));                                   // 31 → 2, 30 → 1, 61 → 3
      expect(own.every((c) => c.ids.length <= PAGE_SIZE + 1)).toBe(true);                // 서버가 전체 목록이 아니라 최대 31행만 보낸다
    } else {
      expect(t.calls.length, "OFF 는 새 페이지 RPC 를 쓰지 않는다").toBe(0);
    }
  });
}

test(`[플래그 ${FLAG_ON ? "ON" : "OFF"}] 검색: 센터명으로 좁혀지고, 지우면 목록 복원, 결과 없음 문구`, async ({ page }) => {
  await openAdmin(page);
  await expect(page.locator("[data-center-id]").first()).toBeVisible({ timeout: 30_000 });
  await search(page).fill(`${PFX}-pending-007`);
  await expect(page.locator("[data-center-id]")).toHaveCount(1, { timeout: 15_000 });
  await expect(page.locator(".admin-center-name")).toHaveText(`${PFX}-pending-007`);
  await page.getByLabel("검색어 지우기").click();
  await expect.poll(() => page.locator("[data-center-id]").count(), { timeout: 15_000 }).toBe(PAGE_SIZE);
  await search(page).fill("존재하지않는검색어-xyz");
  await expect(page.getByText("검색 결과가 없어요")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("[data-center-id]")).toHaveCount(0);
});

test(`[플래그 ${FLAG_ON ? "ON" : "OFF"}] [응답 지연 조작(mock)] 빠른 탭 전환·검색 중 늦게 도착한 이전 응답은 무시되고 최종 선택의 결과만 남는다`, async ({ page }) => {
  await openAdmin(page);
  await expect(page.locator("[data-center-id]").first()).toBeVisible({ timeout: 30_000 });
  // 승인됨 탭 응답을 1.5초 늦춘다(실제 서버 응답 그대로, 지연만 조작).
  const rpc = FLAG_ON ? /\/rpc\/admin_list_centers_page/ : /\/rpc\/admin_list_centers(\?|$)/;
  let slow = true;
  await page.route(rpc, async (route) => {
    const body = route.request().postData() ?? "";
    if (slow && body.includes('"approved"')) await new Promise((r) => setTimeout(r, 1500));
    await route.continue();
  });
  await selectTab(page, "승인됨");                 // 느린 요청 시작
  await selectTab(page, "반려됨");                 // 곧바로 다른 탭 — 빠른 응답
  await expect.poll(async () => (await domIds(page)).length, { timeout: 15_000 }).toBe(PAGE_SIZE);
  await page.waitForTimeout(2200);                 // 늦은 응답이 도착할 시간
  slow = false;
  const dom = await domIds(page);
  expect(dom.slice(0, PAGE_SIZE), "반려됨 탭 첫 30개만 남는다(승인됨 응답이 덮어쓰지 않음)").toEqual(expectedIds("rejected").slice(0, PAGE_SIZE));
  expect(await page.locator(".admin-card", { hasText: "승인됨" }).count(), "승인됨 카드가 남지 않는다").toBe(0);
  // 탭을 바꾸는 동안 이전 탭의 승인/반려 버튼이 남지 않는다: 승인됨 → 승인 대기 전환 직후
  await selectTab(page, "승인대기");
  await expect.poll(() => page.locator("[data-center-id]").count(), { timeout: 15_000 }).toBe(PAGE_SIZE);
  expect(await page.locator(".admin-card", { hasText: "반려됨" }).count(), "반려됨 카드가 남지 않는다").toBe(0);
});

test("[접근 거부] 플랫폼 관리자가 아닌 계정(센터 오너)은 센터 목록을 볼 수 없고 새 페이지 RPC 호출도 거절된다", async ({ page }) => {
  const t = trackPages(page);
  await loginAs(page, U.M, "m@test.invalid");
  await page.goto("/admin/centers");
  await page.waitForTimeout(3000);
  await expect(page.locator("[data-center-id]")).toHaveCount(0);
  await expect(page.getByText("플랫폼 운영자만 접근할 수 있는 화면이에요")).toBeVisible();   // 거부 화면(제목만 같고 본문·검색·탭·카드 없음)
  await expect(search(page)).toHaveCount(0);
  await expect(page.locator(".center-chip")).toHaveCount(0);
  await t.flush();
  expect(t.calls.filter((c) => c.status === 200 && c.ids.length > 0)).toEqual([]);
});
