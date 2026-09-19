import { test, expect, type Page } from "@playwright/test";
import { MANAGER_AUTH_FILE } from "../fixtures/authFiles";

/*
  Web QA P2 Fix Batch(2026-09-19) — 반응형 breakpoint 경계 자동 검증.

  배경: Chrome QA 1차 패스에서 Claude-in-Chrome의 resize_window 도구가 정확한
  픽셀 뷰포트를 안정적으로 재현하지 못하는 한계가 확인됐다(같은 탭에 반복
  resize를 걸면 두 번째 호출부터 요청값을 무시하고 이전 크기를 유지하는 현상을
  재현·확정함). Playwright의 page.setViewportSize()는 실제 브라우저 창이 아니라
  headless/headed 컨텍스트의 뷰포트 자체를 지정하므로 이 문제가 없다 — 767/768,
  1279/1280, 1359/1360 세 경계를 정확히 자동 검증하는 데 이 파일을 쓴다.

  breakpoint 정책(app/globals.css "Responsive workspace shell" 참고, 이 정책
  자체는 이번 배치에서 바꾸지 않음). 세 경계는 서로 "다른 것"이 바뀐다는 점에
  주의(처음 작성 시 세 경계 모두 같은 bottom-nav/sidebar 토글이 일어난다고
  잘못 가정해 1280/1360 경계 테스트가 실패했었다 — 아래는 그 수정본):
    <768         모바일 하단 네비(.bottom-nav) 노출, 사이드바 없음 ← 유일하게
                 .bottom-nav ↔ 사이드바가 토글되는 경계
    768-1279     태블릿 아이콘 레일(폭 88px, hover/focus 시에만 244px로 확장)
    1280+        데스크톱 워크스페이스(사이드바는 계속 88px 레일 그대로,
                 콘텐츠 영역에 패널/그리드가 추가되는 것뿐 — nav 자체는 안 변함)
    1360+        사이드바가 244px 라벨 폭으로 "항상" 확장(hover 불필요)

  P2-44 관련: 이 스펙은 `.desktop-nav-note`(회원 데스크톱 사이드바 하단 안내
  문구) 자체가 내부적으로 텍스트를 잘라내는지(scrollWidth/Height >
  clientWidth/Height)만 검증한다 — QA 1차 패스에서 관찰된 겹침은 재조사 결과
  Next.js 개발 모드 전용 dev-tools 인디케이터(우하단 "N" 배지)가 우연히 겹친
  것으로 확인됐고(production build로 재현 시 사라짐), 앱 코드의 실제 버그가
  아니었다 — 그래서 이 스펙은 앱 코드가 자체적으로 텍스트를 안 잘라내는지만
  확인하고, dev-tools 배지 유무는 검증 범위에 포함하지 않는다.
*/

async function overflowX(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

function clippingOf(el: Element) {
  return { xClipped: el.scrollWidth > el.clientWidth + 1, yClipped: el.scrollHeight > el.clientHeight + 1 };
}

test.describe("회원 데스크톱 사이드바 — breakpoint 경계 자동 검증(로그인 불필요)", () => {
  test("767→768px: 하단 네비 ↔ 사이드바 전환", async ({ page }) => {
    await page.setViewportSize({ width: 767, height: 900 });
    await page.goto("/");
    await expect(page.locator(".bottom-nav")).toBeVisible();
    await expect(page.locator(".member-desktop-nav")).toBeHidden();
    expect(await overflowX(page)).toBeLessThanOrEqual(1);

    await page.setViewportSize({ width: 768, height: 900 });
    await page.reload();
    await expect(page.locator(".member-desktop-nav")).toBeVisible();
    await expect(page.locator(".bottom-nav")).toBeHidden();
    expect(await overflowX(page)).toBeLessThanOrEqual(1);
  });

  test("1279→1280px: 사이드바는 계속 보이고(88px 레일 유지), 가로 스크롤이 생기지 않음", async ({ page }) => {
    for (const width of [1279, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/");
      await expect(page.locator(".member-desktop-nav")).toBeVisible();
      await expect(page.locator(".bottom-nav")).toBeHidden();
      const box = await page.locator(".member-desktop-nav").boundingBox();
      expect(box?.width, `${width}px에서 88px 레일 폭 유지`).toBeLessThan(120);
      expect(await overflowX(page)).toBeLessThanOrEqual(1);
    }
  });

  test("1359→1360px: 사이드바가 88px 레일에서 244px 라벨 사이드바로 확장됨(hover 불필요)", async ({ page }) => {
    await page.setViewportSize({ width: 1359, height: 900 });
    await page.goto("/");
    const railBox = await page.locator(".member-desktop-nav").boundingBox();
    expect(railBox?.width).toBeLessThan(120);
    expect(await overflowX(page)).toBeLessThanOrEqual(1);

    await page.setViewportSize({ width: 1360, height: 900 });
    await page.reload();
    const expandedBox = await page.locator(".member-desktop-nav").boundingBox();
    expect(expandedBox?.width).toBeGreaterThanOrEqual(240);
    expect(await overflowX(page)).toBeLessThanOrEqual(1);
  });

  test("1360px+ 사이드바 안내 문구(.desktop-nav-note)가 자체적으로 잘리지 않음", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    const note = page.locator(".desktop-nav-note");
    await expect(note).toBeVisible();
    await expect(note).toHaveText("태블릿과 데스크톱에서는 더 넓은 화면으로 편하게 탐색할 수 있어요.");
    const clipped = await note.evaluate(clippingOf);
    expect(clipped.xClipped, "가로 방향으로 텍스트가 잘리면 안 됨").toBe(false);
    expect(clipped.yClipped, "세로 방향으로 텍스트가 잘리면 안 됨").toBe(false);
  });

  test("768-1359px 아이콘 레일 hover 시 244px로 확장되고 안내 문구도 잘리지 않음", async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 900 });
    await page.goto("/");
    const nav = page.locator(".member-desktop-nav");
    await expect(nav).toBeVisible();
    const collapsedBox = await nav.boundingBox();
    expect(collapsedBox?.width).toBeLessThan(120); // 88px 레일

    await nav.hover();
    await page.waitForTimeout(300); // width 트랜지션(220ms) 완료 대기
    const expandedBox = await nav.boundingBox();
    expect(expandedBox?.width).toBeGreaterThanOrEqual(240);

    const note = page.locator(".desktop-nav-note");
    const clipped = await note.evaluate(clippingOf);
    expect(clipped.xClipped).toBe(false);
    expect(clipped.yClipped).toBe(false);
  });
});

test.describe("관리자 사이드바 — breakpoint 경계 자동 검증", () => {
  test.use({ storageState: MANAGER_AUTH_FILE });

  test("767→768px: 하단 네비 ↔ 사이드바 전환", async ({ page }) => {
    await page.setViewportSize({ width: 767, height: 900 });
    await page.goto("/manager");
    await expect(page.locator(".bottom-nav")).toBeVisible();
    await expect(page.locator(".workspace-sidebar")).toBeHidden();
    expect(await overflowX(page)).toBeLessThanOrEqual(1);

    await page.setViewportSize({ width: 768, height: 900 });
    await page.reload();
    await expect(page.locator(".workspace-sidebar")).toBeVisible();
    await expect(page.locator(".bottom-nav")).toBeHidden();
    expect(await overflowX(page)).toBeLessThanOrEqual(1);
  });

  test("1279→1280px: 사이드바는 계속 88px 레일 그대로, 가로 스크롤 없음", async ({ page }) => {
    for (const width of [1279, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/manager");
      await expect(page.locator(".workspace-sidebar")).toBeVisible();
      await expect(page.locator(".bottom-nav")).toBeHidden();
      const box = await page.locator(".workspace-sidebar").boundingBox();
      expect(box?.width, `${width}px에서 88px 레일 폭 유지`).toBeLessThan(120);
      expect(await overflowX(page)).toBeLessThanOrEqual(1);
    }
  });

  test("1359→1360px: 사이드바가 88px 레일에서 244px 라벨 사이드바로 확장됨", async ({ page }) => {
    await page.setViewportSize({ width: 1359, height: 900 });
    await page.goto("/manager");
    const railBox = await page.locator(".workspace-sidebar").boundingBox();
    expect(railBox?.width).toBeLessThan(120);
    expect(await overflowX(page)).toBeLessThanOrEqual(1);

    await page.setViewportSize({ width: 1360, height: 900 });
    await page.reload();
    const expandedBox = await page.locator(".workspace-sidebar").boundingBox();
    expect(expandedBox?.width).toBeGreaterThanOrEqual(240);
    expect(await overflowX(page)).toBeLessThanOrEqual(1);
  });
});
