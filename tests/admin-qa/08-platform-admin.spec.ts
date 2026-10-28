import { test, expect, openAs, shot } from "./helpers";
import type { BrowserContext, Page } from "@playwright/test";

/* [플랫폼 관리자] /admin/* 화면 — 읽기 전용 순회(승인·반려·수정 클릭 없음). [센터 오너/일반 회원] 은 같은 화면에서 접근 거부. */
const PAGES: Array<[string, RegExp]> = [
  ["/admin", /관리|운영|플랫폼|센터|대시보드/], ["/admin/centers", /센터 승인 관리/], ["/admin/banners", /배너/], ["/admin/categories", /종목 관리/],
  ["/admin/marketing", /마케팅|메시지|발송/], ["/admin/reviews", /후기|리뷰/], ["/admin/settlement", /정산/], ["/admin/subscription-plans", /구독|플랜/], ["/admin/subscriptions", /구독/],
];
test.describe("플랫폼 관리자", () => {
  let ctx: BrowserContext; let page: Page; let errors: string[];
  test.beforeAll(async ({ browser }) => { ({ ctx, page, errors } = await openAs(browser, "platform")); });
  test.afterAll(async () => { await ctx.close(); });
  for (const [path, heading] of PAGES) {
    test(`[플랫폼 관리자] ${path} — 로드·제목 표시·페이지 오류 없음(읽기 전용)`, async () => {
      const before = errors.length;
      await page.goto(path); await page.waitForLoadState("networkidle");
      await expect(page.locator("body")).toContainText(heading, { timeout: 15_000 });
      await expect(page.getByText("플랫폼 운영자만 접근할 수 있는 화면이에요")).toHaveCount(0);
      await shot(page, `08-platform${path.replace(/\//g, "_")}`);
      expect(errors.slice(before)).toEqual([]);
    });
  }
});
test.describe("비운영자 접근 거부", () => {
  for (const role of ["owner", "member"] as const) {
    test(`[${role === "owner" ? "센터 오너" : "일반 회원"}] /admin/centers·/admin/settlement — 접근 거부 안내, 목록·데이터 없음`, async ({ browser }) => {
      const { ctx, page } = await openAs(browser, role);
      try {
        for (const p of ["/admin/centers", "/admin/settlement"]) {
          await page.goto(p); await page.waitForLoadState("networkidle");
          await expect(page.getByText(/플랫폼 운영자만|접근할 수 없|권한이 없/).first()).toBeVisible({ timeout: 15_000 });
          await expect(page.locator(".admin-card")).toHaveCount(0);
        }
        await shot(page, `08-denied-${role}`);
      } finally { await ctx.close(); }
    });
  }
});
