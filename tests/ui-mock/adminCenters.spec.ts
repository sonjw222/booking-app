/* 관리자 센터 승인 화면(app/admin/centers/page.tsx)의 목록·페이지네이션·검색·탭 전환을 격리 환경에서 검증한다.
   실제 Supabase/공유 DEV/운영에 접속하지 않는다 — 브라우저 단에서 RPC(admin_list_centers / admin_list_centers_page)와 accounts 조회를
   합성 데이터로 가로채 응답한다(서버 커서 규칙은 SQL 정의와 동일하게 재현: created_at desc, id desc, limit+1 lookahead).
   플래그 두 모드를 모두 검증한다: NEXT_PUBLIC_ADMIN_CENTER_PAGINATION 미설정(운영 기본 = 전량 조회 후 클라이언트 페이지) / "true"(서버 커서 RPC).
   실행: UI_MOCK_PORT=3105 NEXT_PUBLIC_ADMIN_CENTER_PAGINATION=true npx playwright test -c playwright.mock.config.ts tests/ui-mock/adminCenters.spec.ts --project=desktop-chromium
         UI_MOCK_PORT=3106                                           npx playwright test -c playwright.mock.config.ts tests/ui-mock/adminCenters.spec.ts --project=desktop-chromium */
import { test, expect, type Page, type Route } from "@playwright/test";
import { mockSupabase } from "./support/mockSupabase";
import { PAGE_SIZE, verifyTabPagination, type PageCall } from "../e2e/fixtures/adminPaginationVerify";

const SERVER_MODE = process.env.NEXT_PUBLIC_ADMIN_CENTER_PAGINATION === "true";
type Status = "pending" | "approved" | "rejected";
type Row = { id: string; name: string; address: string; phone: string; business_number: string; business_license_url: string | null; status: Status; reject_reason: string | null; created_at: string; owner_name: string; owner_phone: string };

function makeRows(status: Status, n: number, prefix = status): Row[] {
  const base = Date.parse("2026-10-01T00:00:00Z");
  return Array.from({ length: n }, (_, i) => ({
    id: `${prefix}-${String(i).padStart(5, "0")}`, name: `${prefix} 센터 ${String(i).padStart(5, "0")}`, address: `서울 ${i}번지`, phone: "02-000-0000",
    business_number: "000-00-00000", business_license_url: null, status, reject_reason: status === "rejected" ? "사유" : null,
    created_at: new Date(base - Math.floor(i / 2) * 60_000).toISOString(), // 동률 created_at 섞기(보조 키 id 필요)
    owner_name: "대표", owner_phone: "010-0000-0000",
  }));
}
const sortDesc = (rows: Row[]) => [...rows].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id.localeCompare(a.id));

type Server = { calls: PageCall[]; delayMs: (keyword: string) => number };
async function installAdminApi(page: Page, data: Record<Status, Row[]>, opts: { admin?: boolean; delay?: (keyword: string) => number; failRpc?: boolean } = {}): Promise<Server> {
  await mockSupabase(page, { loggedIn: true });
  const server: Server = { calls: [], delayMs: opts.delay ?? (() => 0) };
  await page.route("**/rest/v1/accounts*", (route) => route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(opts.admin === false ? { is_platform_admin: false } : { is_platform_admin: true }) }));
  await page.route(/\/rest\/v1\/rpc\/admin_list_centers(_page)?(\?|$)/, async (route: Route) => {
    const body = (route.request().postDataJSON() ?? {}) as { p_status: Status; p_keyword?: string; p_limit?: number; p_before_id?: string | null; p_before_created_at?: string | null };
    const kw = (body.p_keyword ?? "").trim().toLowerCase();
    await new Promise((r) => setTimeout(r, server.delayMs(kw)));
    if (opts.failRpc) return route.fulfill({ status: 500, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ message: "boom" }) });
    let rows = sortDesc(data[body.p_status]);
    if (SERVER_MODE) {
      if (kw) rows = rows.filter((r) => [r.name, r.address, r.phone, r.owner_name].join(" ").toLowerCase().includes(kw));
      if (body.p_before_id && body.p_before_created_at) {
        const bt = Date.parse(body.p_before_created_at);
        rows = rows.filter((r) => Date.parse(r.created_at) < bt || (Date.parse(r.created_at) === bt && r.id < body.p_before_id!));
      }
      rows = rows.slice(0, (body.p_limit ?? PAGE_SIZE) + 1); // limit + lookahead 1행
    }
    server.calls.push({ ids: rows.map((r) => r.id), body: { p_before_id: body.p_before_id ?? null, p_status: body.p_status, p_keyword: body.p_keyword, p_limit: body.p_limit }, status: 200 });
    return route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(rows) });
  });
  return server;
}

const cardIds = (page: Page) => page.locator(".admin-card").evaluateAll((els) => els.map((e) => e.getAttribute("data-center-id")!));
const more = (page: Page) => page.getByRole("button", { name: "센터 더 보기" });
async function loadAll(page: Page) {
  for (let i = 0; i < 80; i++) {
    if (!(await more(page).isVisible().catch(() => false))) return;
    const before = await page.locator(".admin-card").count();
    await more(page).click();
    await expect.poll(async () => await page.locator(".admin-card").count(), { timeout: 10_000 }).toBeGreaterThan(before);
  }
  throw new Error("더 보기가 끝나지 않음");
}

test.describe(`관리자 센터 승인 목록 (${SERVER_MODE ? "서버 커서 RPC" : "전량 조회 + 클라이언트 페이지(운영 기본)"})`, () => {
  for (const n of [29, 30, 31, 100]) {
    test(`승인대기 ${n}개 — 30개씩 표시, 중복·누락 없음, 끝에서 더 보기 사라짐`, async ({ page }) => {
      const data = { pending: makeRows("pending", n), approved: [], rejected: [] };
      const server = await installAdminApi(page, data);
      await page.goto("/admin/centers");
      await expect(page.locator(".admin-card").first()).toBeVisible();
      expect(await page.locator(".admin-card").count()).toBe(Math.min(n, PAGE_SIZE));
      expect(await more(page).isVisible()).toBe(n > PAGE_SIZE);   // 30개면 없음, 31개부터 있음
      await loadAll(page);
      const ids = await cardIds(page);
      expect(ids).toEqual(sortDesc(data.pending).map((r) => r.id));    // 순서·개수 서버 정렬과 동일 = 중복/누락 없음
      expect(new Set(ids).size).toBe(ids.length);
      if (SERVER_MODE) {
        const v = verifyTabPagination({ calls: server.calls.filter((c) => c.body.p_status === "pending" && !c.body.p_keyword), domIds: ids, moreButtonVisibleAtEnd: await more(page).isVisible() });
        expect(v.problems).toEqual([]);
      }
    });
  }

  test("승인대기 1,000개 — 끝까지 불러와도 1,000개 정확히, 중복 없음", async ({ page }) => {
    const data = { pending: makeRows("pending", 1000), approved: [], rejected: [] };
    await installAdminApi(page, data);
    await page.goto("/admin/centers");
    await expect(page.locator(".admin-card").first()).toBeVisible();
    await loadAll(page);
    const ids = await cardIds(page);
    expect(ids.length).toBe(1000);
    expect(new Set(ids).size).toBe(1000);
    expect(ids).toEqual(sortDesc(data.pending).map((r) => r.id));
  });

  test("상태 탭 전환 — 이전 탭 카드·승인/반려 버튼이 남지 않고 해당 상태 데이터만 보인다", async ({ page }) => {
    const data = { pending: makeRows("pending", 5), approved: makeRows("approved", 3), rejected: makeRows("rejected", 2) };
    await installAdminApi(page, data, { delay: () => 150 });
    await page.goto("/admin/centers");
    await expect(page.locator(".admin-card")).toHaveCount(5);
    await expect(page.getByRole("button", { name: "승인", exact: true }).first()).toBeVisible();
    await page.getByRole("button", { name: "승인됨" }).click();
    // 전환 직후(응답 전)에는 이전 탭 카드가 남아 있으면 안 된다
    await expect(page.locator('.admin-card[data-center-id^="pending-"]')).toHaveCount(0);
    await expect(page.getByRole("button", { name: "승인", exact: true })).toHaveCount(0);
    await expect(page.locator(".admin-card")).toHaveCount(3);
    expect((await cardIds(page)).every((id) => id.startsWith("approved-"))).toBe(true);
    await page.getByRole("button", { name: "반려됨" }).click();
    await expect(page.locator(".admin-card")).toHaveCount(2);
    expect((await cardIds(page)).every((id) => id.startsWith("rejected-"))).toBe(true);
  });

  test("검색 — 결과가 있으면 필터, 없으면 검색어를 보여주는 빈 상태, 지우면 전체 복귀(탭 유지)", async ({ page }) => {
    const data = { pending: makeRows("pending", 40), approved: [], rejected: [] };
    await installAdminApi(page, data);
    await page.goto("/admin/centers");
    await expect(page.locator(".admin-card").first()).toBeVisible();
    const box = page.getByPlaceholder("센터명, 대표자, 주소, 전화번호로 검색");
    await box.fill("00007");
    await expect(page.locator(".admin-card")).toHaveCount(1);
    await box.fill("없는검색어xyz");
    await expect(page.getByText("'없는검색어xyz' 검색 결과가 없어요")).toBeVisible();
    await expect(page.locator(".admin-card")).toHaveCount(0);
    await page.getByRole("button", { name: "검색어 지우기" }).click();
    await expect(page.locator(".admin-card")).toHaveCount(30);
  });

  test("응답 순서 역전 — 느린 이전 검색의 응답이 최신 검색 결과를 덮어쓰지 않는다", async ({ page }) => {
    const data = { pending: makeRows("pending", 40), approved: [], rejected: [] };
    await installAdminApi(page, data, { delay: (kw) => (kw === "00001" ? 1800 : 0) });
    await page.goto("/admin/centers");
    await expect(page.locator(".admin-card").first()).toBeVisible();
    const box = page.getByPlaceholder("센터명, 대표자, 주소, 전화번호로 검색");
    await box.fill("00001");            // 느린 응답(1.8초)
    await page.waitForTimeout(450);     // 디바운스(300ms) 이후 느린 요청이 먼저 나간 상태
    await box.fill("00002");            // 빠른 최신 요청
    await expect(page.locator(".admin-card")).toHaveCount(1);
    await expect(page.locator('.admin-card[data-center-id="pending-00002"]')).toBeVisible();
    await page.waitForTimeout(2200);    // 느린 응답이 도착한 뒤에도
    await expect(page.locator(".admin-card")).toHaveCount(1);
    await expect(page.locator('.admin-card[data-center-id="pending-00002"]')).toBeVisible();
  });

  test("느린 응답 중에는 로딩 상태가 보이고 오래된 카드가 남지 않는다", async ({ page }) => {
    const data = { pending: makeRows("pending", 3), approved: makeRows("approved", 3), rejected: [] };
    await installAdminApi(page, data, { delay: () => 800 });
    await page.goto("/admin/centers");
    await expect(page.getByRole("status")).toContainText("불러오는 중");
    await expect(page.locator(".admin-card")).toHaveCount(3);
  });

  test("조회 실패 — 오류 알림을 보이고 앱이 깨지지 않는다", async ({ page }) => {
    await installAdminApi(page, { pending: makeRows("pending", 3), approved: [], rejected: [] }, { failRpc: true });
    await page.goto("/admin/centers");
    await expect(page.locator(".error-toast")).toContainText("센터 목록을 불러오지 못했어요");
  });

  test("플랫폼 관리자가 아니면 목록 RPC를 호출하지 않고 접근 불가 안내만 보인다", async ({ page }) => {
    const server = await installAdminApi(page, { pending: makeRows("pending", 3), approved: [], rejected: [] }, { admin: false });
    await page.goto("/admin/centers");
    await expect(page.getByText("플랫폼 운영자만 접근할 수 있는 화면이에요")).toBeVisible();
    expect(server.calls.length).toBe(0);
    await expect(page.locator(".admin-card")).toHaveCount(0);
  });
});
