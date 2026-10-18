/* 전/후 스크린샷 수집(SHOT_DIR 이 있을 때만 실행). 같은 격리 실데이터(PostgREST)를 보는 두 앱(main / UX 브랜치)에서 같은 시나리오를 찍는다. */
import { expect, test } from "@playwright/test";
const OUT = process.env.SHOT_DIR;
const AFTER = process.env.SHOT_AFTER === "1";
const C1 = "00000000-0000-4000-8000-000000000001", CLS1 = "00000000-0000-4000-8000-0000000000c1";
test.skip(!OUT, "SHOT_DIR 미설정");
test.describe.configure({ mode: "serial" });
for (const width of [375, 390, 768, 1024, 1440]) for (const theme of ["light", "dark"] as const) {
  test(`shots ${width} ${theme}`, async ({ page }) => {
    test.setTimeout(150_000);
    await page.setViewportSize({ width, height: width >= 768 ? 900 : 844 });
    const shot = async (name: string) => { if (theme === "dark") await page.evaluate(() => document.documentElement.setAttribute("data-theme", "charcoal")); await page.waitForTimeout(theme === "dark" ? 900 : 500); await page.screenshot({ path: `${OUT}/${width}-${theme}-${name}.png` }); };
    await page.goto("/"); await page.waitForTimeout(1200); await shot("home");
    await page.goto("/category/%EC%9A%94%EA%B0%80?s=distance"); await page.waitForTimeout(1500); await shot("category");
    await page.goto(`/center/${C1}`);
    // 촬영 전 정상 센터 화면임을 단언한다 — "센터를 찾을 수 없어요" 화면을 찍으면 이 테스트는 실패해야 한다.
    await expect(page.getByText("센터를 찾을 수 없어요")).toHaveCount(0);
    await expect(page.locator(".center-hero-name")).toHaveText("하늘 요가 스튜디오");
    await expect(page.getByRole("button", { name: "센터 공유" })).toBeVisible();
    await expect(page.getByRole("button", { name: /수강권 구매/ }).last()).toBeVisible();   // 변경 전(main)은 "수강권 구매", 후는 "수강권 구매하기"
    await expect(page.getByRole("button", { name: "예약하기" })).toBeVisible();
    await expect(page.locator("nextjs-portal")).toHaveCount(0);   // 개발용 오버레이가 없는 프로덕션 번들
    await page.waitForTimeout(600); await shot("center");
    await page.goto("/search"); await page.waitForTimeout(600); await shot("search");
    if (AFTER) {
      await page.goto("/category/%EC%9A%94%EA%B0%80"); await page.waitForTimeout(1200);
      await page.getByRole("button", { name: /검색 조건/ }).click();
      await expect(page.getByRole("button", { name: "초기화" }).last()).toBeVisible(); await expect(page.getByRole("button", { name: /^적용/ })).toBeVisible();
      await shot("filter-sheet");
      await page.keyboard.press("Escape");
      await page.goto(`/center/${C1}/class/${CLS1}`);
      await expect(page.getByRole("heading", { level: 1, name: "아침 하타 요가" })).toBeVisible();
      await page.waitForTimeout(600); await shot("class-detail");
      await page.getByRole("button", { name: "예약하기" }).click(); await shot("no-pass-dialog");
    }
  });
}
