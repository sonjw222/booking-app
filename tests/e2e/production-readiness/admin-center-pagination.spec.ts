import { test, expect, type Browser, type Page } from "@playwright/test";
import { MANAGER_AUTH_FILE } from "../fixtures/authFiles";
import { PAGE_SIZE, expectedMoreButton, verifyTabPagination, type PageCall } from "../fixtures/adminPaginationVerify";

/* 읽기 전용. DEV의 기존 플랫폼 관리자(TEST_PLATFORM_ADMIN_*)와 이미 존재하는 센터 데이터만 쓴다.
   이 스펙도, CI도 권한 승격·센터 생성/삭제를 하지 않는다. RUN_ADMIN_PAGINATION=1(수동 러너
   scripts/e2e/adminPaginationReadonly.mjs가 설정)일 때만 실행된다.
   결과 구분: 통과=PASS / 의도적 미실행(RUN_ADMIN_PAGINATION 없음)=SKIP / 전제 부족(계정·상태별 31건 이상 데이터·플래그 미선언)=
   skip 사유가 "BLOCKED:"로 시작하는 BLOCKED. BLOCKED·SKIP은 PASS가 아니며 러너 요약(scripts/e2e/adminPaginationSummary.mjs)이 따로 센다.
   순수 검증 규칙(30/31 경계·중복/누락·커서 연속성·DOM↔서버 일치)은 tests/e2e/fixtures/adminPaginationVerify.ts에 있고
   합성 데이터로 오프라인 단위 테스트(tests/unit/adminPaginationVerify.test.ts)가 먼저 검증한다. */

const ADMIN_EMAIL = process.env.TEST_PLATFORM_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.TEST_PLATFORM_ADMIN_PASSWORD;
const FLAG = process.env.E2E_ADMIN_CENTER_PAGINATION_FLAG; // "on" | "off" | undefined
const STATUS_OF = { 승인대기: "pending", 승인됨: "approved", 반려됨: "rejected" } as const;
const TABS = ["승인대기", "승인됨", "반려됨"] as const;

type Row = { id: string };
type RpcCall = { rpc: string; status: number; ids: string[]; body: Record<string, unknown> };
type Tracked = RpcCall[] & { flush: () => Promise<void> };

/* 요청 시점에 자리를 잡고(요청 순서 보존) 응답 본문은 비동기로 채운다. 검증 전에 flush()로 본문 수집이 끝났는지 확인한다. */
function trackRpc(page: Page): Tracked {
  const calls: RpcCall[] = [];
  const slots = new Map<unknown, RpcCall>();
  const pending: Promise<void>[] = [];
  page.on("request", (req) => {
    const m = req.url().match(/\/rest\/v1\/rpc\/(admin_list_centers(?:_page)?)(?:\?|$)/);
    if (!m) return;
    let body: Record<string, unknown> = {};
    try { body = req.postDataJSON() ?? {}; } catch { /* body 없음 */ }
    const call: RpcCall = { rpc: m[1], status: 0, ids: [], body };
    calls.push(call); slots.set(req, call);
  });
  page.on("response", (res) => {
    const call = slots.get(res.request());
    if (!call) return;
    call.status = res.status();
    pending.push((async () => {
      try { call.ids = ((await res.json()) as Row[]).map((r) => r.id); } catch { /* 오류 응답 */ }
    })());
  });
  return Object.assign(calls, { flush: async () => { await Promise.all(pending); } });
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
  const initial = page.waitForResponse(/\/rest\/v1\/rpc\/admin_list_centers/);
  await page.goto("/admin/centers");
  await initial;
  await expect(page.getByText("센터 승인 관리").first()).toBeVisible();
  await settled(page);
  return { context, page, calls, errors };
}

const cards = (page: Page) => page.locator(".admin-card");
const moreBtn = (page: Page) => page.getByRole("button", { name: "센터 더 보기" });
const settled = (page: Page) => expect(page.getByRole("status")).toHaveCount(0, { timeout: 15_000 });

function requireAdmin() {
  test.skip(!ADMIN_EMAIL || !ADMIN_PASSWORD, "BLOCKED: TEST_PLATFORM_ADMIN_EMAIL/TEST_PLATFORM_ADMIN_PASSWORD 없음 — 플랫폼 관리자 계정이 없어 실행 불가(PASS 아님)");
}
const domIdsOf = (page: Page) => cards(page).evaluateAll((els) => els.map((e) => e.getAttribute("data-center-id") ?? ""));

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
  test.beforeEach(() => {
    test.skip(process.env.RUN_ADMIN_PAGINATION !== "1", "Dedicated DEV fixture run only");
    requireAdmin();
  });

  test("플래그 선언과 실제 RPC가 일치한다(ON=admin_list_centers_page, OFF=admin_list_centers)", async ({ browser }) => {
    test.skip(FLAG !== "on" && FLAG !== "off", "BLOCKED: E2E_ADMIN_CENTER_PAGINATION_FLAG=on|off 미선언 — 어떤 빌드를 검증하는지 알 수 없음");
    const { context, page, calls, errors } = await openAsPlatformAdmin(browser);
    try {
      await expect(page.getByText("센터 승인 관리").first()).toBeVisible({ timeout: 15_000 });
      await settled(page);
      await calls.flush();
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.every((c) => c.status === 200), JSON.stringify(calls.map((c) => [c.rpc, c.status]))).toBe(true);
      const expected = FLAG === "on" ? "admin_list_centers_page" : "admin_list_centers";
      expect(new Set(calls.map((c) => c.rpc))).toEqual(new Set([expected]));
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  });

  for (const tabName of TABS) {
    const status = STATUS_OF[tabName];
    test(`[${tabName}] 첫 페이지 30개 포함 전 페이지의 서버 응답 id와 화면 DOM id가 일치(중복·누락 없음, 30/31 경계)`, async ({ browser }) => {
      test.skip(FLAG !== "on", "BLOCKED: 커서 페이지네이션은 플래그 ON 빌드(E2E_ADMIN_CENTER_PAGINATION_FLAG=on)에서만 검증한다");
      const { context, page, calls, errors } = await openAsPlatformAdmin(browser);
      try {
        if (tabName !== "승인대기") await page.getByRole("button", { name: tabName, exact: true }).click(); // 승인대기는 최초 로드가 첫 페이지
        await settled(page);
        // 이 탭의 첫 페이지 응답부터 전부(최초 로드 포함 — 이전 버전은 첫 페이지 30개를 검증에서 빠뜨렸다).
        const mine = async (): Promise<RpcCall[]> => { await calls.flush(); return calls.filter((c) => c.rpc === "admin_list_centers_page" && c.body.p_status === status && c.status === 200); };

        let guard = 0;
        for (;;) {
          const so = await mine();
          const last = so[so.length - 1];
          expect(last, `[${tabName}] 첫 페이지 응답이 없음`).toBeTruthy();
          // 30/31 경계: 마지막 응답이 31행(30+lookahead)일 때만 '더 보기'가 있어야 한다.
          const hasMore = expectedMoreButton(last as PageCall);
          await expect(moreBtn(page), `응답 ${last.ids.length}행 → 더 보기 ${hasMore ? "있어야" : "없어야"} 함`).toHaveCount(hasMore ? 1 : 0);
          if (!hasMore) break;
          expect(guard++, "더 보기 루프가 상한에 도달 — 커서가 끝나지 않음").toBeLessThan(50);
          const before = so.length;
          await moreBtn(page).click();
          await expect.poll(async () => (await mine()).length, { timeout: 15_000 }).toBeGreaterThan(before);
          await settled(page);
        }

        const verdict = verifyTabPagination({ calls: (await mine()) as PageCall[], domIds: await domIdsOf(page), moreButtonVisibleAtEnd: await moreBtn(page).isVisible() });
        test.info().annotations.push({ type: "boundary", description: `${tabName}: ${verdict.boundary}, ${verdict.pages}페이지, 화면 ${verdict.expectedIds.length}행` });
        expect(verdict.problems, `[${tabName}] 서버 응답 ↔ DOM 검증`).toEqual([]);
        expect(errors).toEqual([]);
        // 위 검증은 통과했어도 데이터가 31건 미만이면 경계·더 보기·커서 연속성은 실행되지 않았다 — PASS로 세지 않는다.
        test.skip(verdict.boundary === "single-page-under-30" || verdict.boundary === "exactly-30",
          `BLOCKED: [${tabName}] 기존 데이터가 ${verdict.expectedIds.length}건(<=${PAGE_SIZE})이라 30/31 경계·더 보기·커서 연속성을 검증하지 못함 — 31건 이상 필요(단일 페이지 DOM↔서버 일치만 확인됨)`);
      } finally { await context.close(); }
    });
  }

  test("검색 debounce: 빠른 키 입력은 마지막 검색어 1회만 요청한다", async ({ browser }) => {
    const { context, page, calls } = await openAsPlatformAdmin(browser);
    try {
      await settled(page);
      const search = page.getByPlaceholder("센터명, 대표자, 주소, 전화번호로 검색");
      const before = calls.length;
      await search.pressSequentially("abc", { delay: 40 }); // 300ms 안에 연속 입력
      await expect.poll(async () => { await calls.flush(); return calls.slice(before).filter((c) => c.status === 200).length; }, { timeout: 15_000 }).toBeGreaterThan(0);
      await settled(page);
      await calls.flush();
      const sent = calls.slice(before);
      if (FLAG === "on") {
        expect(sent.map((c) => c.body.p_keyword), "debounce 후 마지막 검색어로만 요청").toEqual(["abc"]);
      } else {
        expect(sent.length, "빠른 입력당 1회만 요청").toBeLessThanOrEqual(1);
      }
      await expect(search).toHaveValue("abc");
      const last = sent[sent.length - 1];
      if (FLAG === "on" && last) expect(await domIdsOf(page)).toEqual(last.ids.slice(0, PAGE_SIZE));
    } finally { await context.close(); }
  });

  /* 응답 순서 역전(실제 서버·실제 브라우저): 단순 지연이 아니라 A 요청을 route에서 보류(응답을 전달하지 않음)한 채
     B 요청을 먼저 완료시키고, 그 뒤에 A를 풀어 A 응답을 브라우저에 전달한다. 최종 화면에는 B 결과만 남아야 한다.
     같은 시나리오의 오프라인 버전(서버 없음)은 tests/unit/adminCenters.searchStale.test.ts가 먼저 검증한다. */
  test("응답 순서 역전: A 요청 보류 → B 완료 → A 뒤늦게 전달해도 화면에는 B 결과만 남는다", async ({ browser }) => {
    test.skip(FLAG !== "on", "BLOCKED: 검색어(p_keyword) 요청을 구분하려면 플래그 ON 빌드가 필요함");
    const { context, page, calls } = await openAsPlatformAdmin(browser);
    try {
      await settled(page);
      const keywordA = "센터";
      const keywordB = `zz-no-such-center-${Date.now()}`; // 결과 0건 — A(결과 있음)와 구분된다
      let releaseA!: () => void;
      const gateA = new Promise<void>((resolve) => { releaseA = resolve; });
      let aHeld = false;
      await page.route(/\/rest\/v1\/rpc\/admin_list_centers_page/, async (route) => {
        let kw: unknown; try { kw = route.request().postDataJSON()?.p_keyword; } catch { /* ignore */ }
        if (kw === keywordA) { aHeld = true; await gateA; }
        await route.continue();
      });
      const search = page.getByPlaceholder("센터명, 대표자, 주소, 전화번호로 검색");
      await search.fill(keywordA);
      await expect.poll(() => aHeld, { timeout: 5_000 }).toBe(true); // A가 서버로 나가기 직전에 보류됨
      // 보류 중에는 이전 목록의 카드·승인/반려 버튼이 남아 있으면 안 된다.
      await expect(cards(page)).toHaveCount(0);
      await expect(page.getByRole("button", { name: "승인", exact: true })).toHaveCount(0);
      await search.fill(keywordB);
      await expect(page.getByText(`'${keywordB}' 검색 결과가 없어요`)).toBeVisible({ timeout: 15_000 }); // B 완료
      releaseA(); // 이제서야 A 요청을 서버로 보내고 그 응답을 브라우저에 전달한다
      await expect.poll(async () => { await calls.flush(); return calls.some((c) => c.body.p_keyword === keywordA && c.status === 200); }, { timeout: 15_000 }).toBe(true);
      await page.waitForTimeout(500); // A 응답이 앱 상태에 반영될 기회를 준다
      const a = calls.find((c) => c.body.p_keyword === keywordA && c.status === 200)!;
      test.skip(a.ids.length === 0, "BLOCKED: A 검색어('센터') 결과가 0건이라 A/B 응답을 화면에서 구분할 수 없음 — 결과가 있는 검색어가 필요");
      await expect(cards(page)).toHaveCount(0); // A의 카드가 되살아나지 않음
      await expect(page.getByText(`'${keywordB}' 검색 결과가 없어요`)).toBeVisible();
      await expect(search).toHaveValue(keywordB);
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
      await expect(page.locator(".error-toast")).toBeVisible({ timeout: 15_000 });
      // 이전 탭(승인대기)의 카드·승인/반려 버튼이 실패한 새 탭 아래에 남으면 안 된다.
      await expect(cards(page)).toHaveCount(0);
      await expect(page.getByRole("button", { name: "승인", exact: true })).toHaveCount(0);
      await expect(moreBtn(page)).toHaveCount(0);
    } finally { await context.close(); }
  });
});
