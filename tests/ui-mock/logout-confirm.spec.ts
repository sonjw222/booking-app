import { expect, test } from "@playwright/test";
import { mockSupabase } from "./support/mockSupabase";

// 감사 추가 항목: SPA 링크 이동 후 로그아웃 확인창이 눌리지 않는다는 보고를 실제 링크 이동으로 재현한다(새로고침/직접 goto 우회 없음).
test.describe("로그아웃 확인창 — 링크 이동 후", () => {
  test("홈 → 하단 탭 '마이' 클릭(SPA 이동) → 로그아웃 → 확인창의 취소/확인이 모두 동작", async ({ page }) => {
    await mockSupabase(page, { loggedIn: true, hasPass: true });
    await page.goto("/");
    await page.getByRole("link", { name: /마이/ }).first().click();
    await page.waitForURL(/\/mypage/);
    // 데스크톱에서는 링크를 누른 뒤 포인터가 사이드바 위에 남아 사이드바가 펼쳐진 채 콘텐츠를 덮는다(자동화 도구가 포인터를 옮기지 않으면 클릭이 가로채임).
    // 사람은 포인터를 움직이므로 같은 동작으로 포인터를 콘텐츠 쪽으로 옮긴다.
    await page.mouse.move(Math.round((page.viewportSize()?.width ?? 800) * 0.6), 300);
    const logout = page.locator(".logout-row");
    await expect(logout).toBeVisible();

    await logout.click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toHaveCount(1);
    await dialog.getByRole("button", { name: "취소" }).click();       // 취소는 닫기만
    await expect(dialog).toHaveCount(0);
    expect(new URL(page.url()).pathname).toBe("/mypage");

    await logout.click();                                              // 다시 열려야 함(요청 큐가 막히지 않음)
    await expect(dialog).toHaveCount(1);
    await dialog.getByRole("button", { name: "확인" }).click();
    await expect(dialog).toHaveCount(0);
    // 로그아웃은 전체 페이지 이동(window.location)이라 waitForURL 이 ERR_ABORTED 를 낼 수 있어 URL 을 폴링한다.
    await expect.poll(() => new URL(page.url()).pathname, { timeout: 15000 }).not.toMatch(/^\/mypage/);
  });
});
