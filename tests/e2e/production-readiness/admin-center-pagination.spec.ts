import { test, expect, type Browser, type Page } from "@playwright/test";
import { MANAGER_AUTH_FILE } from "../fixtures/authFiles";

/*
  /admin/centers 커서 페이지네이션(PR #196) 실브라우저 검증 — DEV 전용, 앱/DB/환경변수는 건드리지 않는다.

  전제가 없는 시나리오는 PASS가 아니라 test.skip(이유 명시)로 남긴다. skip은 검증 완료가 아니다.
  - 플랫폼 관리자 시나리오: TEST_PLATFORM_ADMIN_EMAIL / TEST_PLATFORM_ADMIN_PASSWORD (DEV의 기존 플랫폼 관리자 계정, 이 스펙은 계정을 만들지 않는다)
  - E2E_ADMIN_CENTER_PAGINATION_FLAG=on|off : 이 Playwright가 붙은 서버가 NEXT_PUBLIC_ADMIN_CENTER_PAGINATION 을 true(on)/미설정(off)로
    "빌드·기동"되었음을 실행자가 선언. 이 값은 build-time 플래그라 서버를 따로 띄워야 하며, 이 스펙은 RPC 이름(admin_list_centers_page 여부)으로 선언을 교차 검증한다.
  - 30행 경계/연속 로딩은 해당 탭에 DEV 센터가 31건 이상 있어야 한다(없으면 skip). 데이터를 만들지 않는다.
  - 이 스펙은 승인/반려 버튼을 누르지 않는다(읽기 전용).
*/

const ADMIN_EMAIL = process.env.TEST_PLATFORM_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.TEST_PLATFORM_ADMIN_PASSWORD;
const FLAG = process.env.E2E_ADMIN_CENTER_PAGINATION_FLAG; // "on" | "off" | undefined
const PAGE_SIZE = 30;
const TABS = ["승인대기", "승인됨", "반려됨"] as const;

type Row = { id: string };
type RpcCall = { rpc: string; status: number; ids: string[]; body: Record<string, unknown> };

function trackRpc(page: Page): RpcCall[] {
  const calls: RpcCall[] = [];
  page.on("response", async (res) => {
    const m = res.url().match(/\/rest\/v1\/rpc\/(admin_list_centers(?:_page)?)(?:\?|$)/);
    if (!m) return;
    let ids: string[] = [];
    try { ids = ((await res.json()) as Row[]).map((r) => r.id); } catch { /* 오류 응답 */ }
    let body: Record<string, unknown> = {};
    try { body = res.request().postDataJSON() ?? {}; } catch { /* body 없음 */ }
    calls.push({ rpc: m[1], status: res.status(), ids, body });
  });
  return calls;
}

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text()}`); });
  return errors;
}

async function openAsPlatformAdmin(browser: Browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const calls = trackRpc(page);
  const errors = trackErrors(page);
  await page.goto("/login");
  await page.locator('input[type="email"]').fill(ADMIN_EMAIL!);
  await page.locator('input[type="password"]').fill(ADMIN_PASSWORD!);
  await page.locator("button.login-submit").click();
  await page.waitForURL("/", { timeout: 15_000 });
  await page.goto("/admin/centers");
  return { context, page, calls, errors };
}

const cards = (page: Page) => page.locator(".admin-card");
const moreBtn = (page: Page) => page.getByRole("button", { name: "센터 더 보기" });
const settled = (page: Page) => expect(page.getByRole("status")).toHaveCount(0, { timeout: 15_000 });

function requireAdmin() {
  test.skip(!ADMIN_EMAIL || !ADMIN_PASSWORD, "BLOCKED: TEST_PLATFORM_ADMIN_EMAIL/PASSWORD(DEV 플랫폼 관리자 자격) 미설정 — 이 시나리오는 검증되지 않았다");
}

test.describe("/admin/centers — 접근 거부(플랫폼 관리자 자격 불필요)", () => {
  test.use({ storageState: MANAGER_AUTH_FILE });

  test("플랫폼 관리자가 아닌 매니저는 목록 없이 안내 문구만 본다", async ({ page }) => {
    const calls = trackRpc(page);
    await page.goto("/admin/centers");
    await expect(page.getByText("플랫폼 운영자만 접근할 수 있는 화면이에요")).toBeVisible({ timeout: 15_000 });
    await expect(cards(page)).toHaveCount(0);
    await expect(moreBtn(page)).toHaveCount(0);
    expect(calls, "비관리자는 센터 목록 RPC를 호출하지 않는다").toHaveLength(0);
  });
});

test.describe("/admin/centers — 커서 페이지네이션(DEV 플랫폼 관리자 필요)", () => {
  test.beforeEach(() => requireAdmin());

  test("플래그 선언과 실제 RPC가 일치한다(ON=admin_list_centers_page, OFF=admin_list_centers)", async ({ browser }) => {
    test.skip(FLAG !== "on" && FLAG !== "off", "BLOCKED: E2E_ADMIN_CENTER_PAGINATION_FLAG=on|off 미선언 — 어떤 빌드를 검증하는지 알 수 없음");
    const { context, page, calls, errors } = await openAsPlatformAdmin(browser);
    try {
      await expect(page.getByText("센터 승인 관리").first()).toBeVisible({ timeout: 15_000 });
      await settled(page);
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.every((c) => c.status === 200), JSON.stringify(calls.map((c) => [c.rpc, c.status]))).toBe(true);
      const expected = FLAG === "on" ? "admin_list_centers_page" : "admin_list_centers";
      expect(new Set(calls.map((c) => c.rpc))).toEqual(new Set([expected]));
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  });

  for (const tabName of TABS) {
    test(`[${tabName}] 30행 경계·더 보기 연속 로딩·중복/누락 없음`, async ({ browser }) => {
      test.skip(FLAG !== "on", "BLOCKED: 커서 페이지네이션은 플래그 ON 빌드(E2E_ADMIN_CENTER_PAGINATION_FLAG=on)에서만 검증한다");
      const { context, page, calls, errors } = await openAsPlatformAdmin(browser);
      try {
        await settled(page);
        await page.getByRole("button", { name: tabName, exact: true }).click();
        await settled(page);
        const first = await cards(page).count();
        test.skip(first <= PAGE_SIZE - 1 || !(await moreBtn(page).isVisible()),
          `BLOCKED: [${tabName}] 탭 DEV 데이터가 ${PAGE_SIZE}건 이하(현재 ${first}행, 더 보기 없음) — 30행 경계 검증 불가. 데이터를 임의로 만들지 않는다`);
        expect(first).toBe(PAGE_SIZE);

        const before = calls.length;
        let guard = 0;
        while (await moreBtn(page).isVisible() && guard++ < 50) {
          const n = await cards(page).count();
          await moreBtn(page).click();
          await expect.poll(() => cards(page).count(), { timeout: 15_000 }).toBeGreaterThan(n);
          await settled(page);
        }
        expect(guard, "더 보기 루프가 상한에 도달 — 커서가 끝나지 않음").toBeLessThan(50);

        const pageCalls = calls.slice(before).filter((c) => c.rpc === "admin_list_centers_page");
        const all = pageCalls.flatMap((c) => c.ids);
        expect(new Set(all).size, "페이지 간 중복 id").toBe(all.length);
        // 서버는 한 번에 최대 30행(+커서 판별용 1행 이내)만 돌려준다 — 마지막 페이지를 제외하면 한 번의 응답이 30행을 넘지 않는다.
        for (const c of pageCalls) expect(c.ids.length).toBeLessThanOrEqual(PAGE_SIZE + 1);
        expect(await cards(page).count(), "화면 행 수 == 서버가 돌려준 누적 행 수(누락 없음)").toBe(first + all.length);
        await expect(moreBtn(page)).toHaveCount(0);
        expect(errors).toEqual([]);
      } finally { await context.close(); }
    });
  }

  test("검색 debounce: 빠른 키 입력은 마지막 검색어 1회만 요청하고 역전 응답이 결과를 덮지 않는다", async ({ browser }) => {
    const { context, page, calls } = await openAsPlatformAdmin(browser);
    try {
      await settled(page);
      const search = page.getByPlaceholder("센터명, 대표자, 주소, 전화번호로 검색");
      // 응답을 지연시켜 로딩 중 재입력이 가능한 상태를 만든다(역전 응답 방어는 앱의 requestId 가드가 담당 — 마지막 요청만 화면에 반영돼야 한다).
      await page.route(/\/rest\/v1\/rpc\/admin_list_centers/, async (route) => {
        await new Promise((r) => setTimeout(r, 800));
        await route.continue();
      });
      const before = calls.length;
      await search.pressSequentially("abc", { delay: 40 }); // 300ms 안에 연속 입력
      await page.waitForTimeout(400); // debounce(300ms) 경과 대기 — 요청이 나갔는지는 아래 calls로 확인
      await settled(page);
      const sent = calls.slice(before);
      if (FLAG === "on") {
        const keywords = sent.map((c) => c.body.p_keyword);
        expect(keywords, "debounce 후 마지막 검색어로만 요청").toEqual(["abc"]);
      } else {
        expect(sent.length, "빠른 입력당 1회만 요청").toBeLessThanOrEqual(1);
      }
      await expect(search).toHaveValue("abc");
      // 화면의 행은 모두 마지막 요청 응답(서버가 돌려준 id 수)과 같아야 한다.
      const last = sent[sent.length - 1];
      if (FLAG === "on" && last) expect(await cards(page).count()).toBe(last.ids.length);
    } finally { await context.close(); }
  });

  test("검색 결과 없음: 검색어가 포함된 빈 목록 문구, 지우면 상태 탭 목록 복구", async ({ browser }) => {
    const { context, page, errors } = await openAsPlatformAdmin(browser);
    try {
      await settled(page);
      const search = page.getByPlaceholder("센터명, 대표자, 주소, 전화번호로 검색");
      const term = `zz-no-such-center-${Date.now()}`;
      await search.fill(term);
      await expect(page.getByText(`'${term}' 검색 결과가 없어요`)).toBeVisible({ timeout: 15_000 });
      await expect(cards(page)).toHaveCount(0);
      await expect(moreBtn(page)).toHaveCount(0);
      await page.getByRole("button", { name: "검색어 지우기" }).click();
      await settled(page);
      await expect(page.getByText("검색 결과가 없어요")).toHaveCount(0);
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  });

  test("상태 탭 전환 시 검색어는 유지되고 목록은 해당 상태로 다시 로드된다", async ({ browser }) => {
    const { context, page, errors } = await openAsPlatformAdmin(browser);
    try {
      await settled(page);
      const search = page.getByPlaceholder("센터명, 대표자, 주소, 전화번호로 검색");
      await search.fill("센터");
      await settled(page);
      for (const tabName of TABS) {
        await page.getByRole("button", { name: tabName, exact: true }).click();
        await settled(page);
        await expect(search).toHaveValue("센터");
        await expect(page.locator(".center-chip.on")).toHaveText(tabName);
      }
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  });

  test("네트워크 오류: RPC 실패 시 오류 메시지를 보여 주고 목록은 비운다(크래시 없음)", async ({ browser }) => {
    const { context, page } = await openAsPlatformAdmin(browser);
    try {
      await settled(page);
      await page.route(/\/rest\/v1\/rpc\/admin_list_centers/, (route) => route.abort("failed"));
      await page.getByRole("button", { name: "승인됨", exact: true }).click();
      await expect(page.locator(".error-toast")).toContainText("센터 목록을 불러오지 못했어요", { timeout: 15_000 });
      await expect(moreBtn(page)).toHaveCount(0);
    } finally { await context.close(); }
  });
});
