import { expect, test, type Page } from "@playwright/test";
import { mockSupabase } from "./support/mockSupabase";

const openClassTab = async (page: Page) => { await page.getByRole("button", { name: "수업", exact: true }).click(); };

test.describe("센터 상세 — CTA · 공유 · 수업 탭", () => {
  test("하단 CTA: 수강권이 없으면 '수강권 구매하기'가 주(네이비 채움), 있으면 '예약하기'가 주", async ({ page }) => {
    await mockSupabase(page, { loggedIn: true, hasPass: false });
    await page.goto("/center/c-near");
    const buy = page.getByRole("button", { name: "수강권 구매하기" }).last();
    const reserve = page.getByRole("button", { name: "예약하기" });
    await expect(buy).toHaveClass(/primary/);
    await expect(reserve).toHaveClass(/secondary/);
    const bg = await buy.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg).toBe("rgb(10, 36, 70)");   // --action-bg 네이비
  });

  test("수강권 보유 회원은 예약하기가 주 동작이고 예약 화면으로 이동(안내 팝업 없음)", async ({ page }) => {
    await mockSupabase(page, { loggedIn: true, hasPass: true });
    await page.goto("/center/c-near");
    const reserve = page.getByRole("button", { name: "예약하기" });
    await expect(reserve).toHaveClass(/primary/);
    const nav = page.waitForURL(/\/reservation\?center=c-near/);
    await reserve.click();
    await nav;
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
  });

  test("수강권 없는 회원이 예약하기 → 중앙 Dialog(제목·본문·버튼), 한 번만 열리고, 취소/ESC로 닫힘, 구매하기는 구매 시트", async ({ page }) => {
    await mockSupabase(page, { loggedIn: true, hasPass: false });
    await page.goto("/center/c-near");
    const reserve = page.getByRole("button", { name: "예약하기" });
    await reserve.evaluate((el: HTMLElement) => { el.click(); el.click(); });   // 연타해도 한 개만(배경 탭은 닫기이므로 실제 더블클릭이 아니라 연속 click 이벤트로 검증)
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toHaveCount(1);
    await expect(dialog.getByRole("heading", { name: "수강권이 필요해요" })).toBeVisible();
    await expect(dialog).toContainText("이 센터의 수강권을 먼저 구매해주세요.");
    await expect(page.locator(".error-toast")).toHaveCount(0);                 // 상단 작은 토스트 대신
    const box = await dialog.boundingBox(); const vp = page.viewportSize()!;
    expect(Math.abs((box!.x + box!.width / 2) - vp.width / 2)).toBeLessThan(2);       // 가로 중앙
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await reserve.click();
    await dialog.getByRole("button", { name: "닫기" }).click();
    await expect(dialog).toHaveCount(0);
    await reserve.click();
    await dialog.getByRole("button", { name: "수강권 구매하기" }).click();
    await expect(page.locator(".sheet-title", { hasText: /수강권|구매/ }).first()).toBeVisible();   // 현재 센터의 구매 시트
    expect(new URL(page.url()).pathname).toBe("/center/c-near");
  });

  test("공유 버튼은 화면 가장자리에서 gutter만큼 떨어져 있고 긴 센터명에서도 화면 안에 있다", async ({ page }) => {
    await mockSupabase(page);
    await page.goto("/center/c-far");
    const share = page.getByRole("button", { name: "센터 공유" });
    await expect(share).toBeVisible();
    const sb = (await share.boundingBox())!; const vp = page.viewportSize()!;
    expect(sb.x + sb.width).toBeLessThanOrEqual(vp.width - 12);
    expect(sb.width).toBeGreaterThanOrEqual(44); expect(sb.height).toBeGreaterThanOrEqual(44);
    const name = (await page.locator(".center-hero-name").boundingBox())!;
    expect(name.x + name.width).toBeLessThanOrEqual(sb.x + 1);                 // 이름이 버튼 밑으로 들어가지 않음
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test("수업 탭: 수업을 누르면 곧바로 예약/구매가 아니라 수업 상세로 이동", async ({ page }) => {
    await mockSupabase(page, { loggedIn: true, hasPass: true });
    await page.goto("/center/c-near");
    await openClassTab(page);
    await page.locator(".center-class-row", { hasText: "아침 하타 요가" }).click();
    await expect(page).toHaveURL(/\/center\/c-near\/class\/cls-1$/);
    await expect(page.getByRole("heading", { level: 1, name: "아침 하타 요가" })).toBeVisible();
    await expect(page.locator(".sheet-overlay")).toHaveCount(0);
  });
});

test.describe("수업 상세", () => {
  test("실제 데이터만 표시: 일정·장소·정원·소개·참여 조건, 없는 항목(강사)은 행 자체가 없다", async ({ page }) => {
    await mockSupabase(page, { loggedIn: true, hasPass: true });
    await page.goto("/center/c-near/class/cls-1");
    const facts = page.locator(".class-detail-facts");
    await expect(facts).toContainText("A룸");
    await expect(facts).toContainText("10명");
    await expect(facts).toContainText("6자리 남음");
    await expect(facts).toContainText("수업 시작 1시간 전까지 예약");
    await expect(facts).toContainText("김하늘, 이가람");   // 로그인: class_trainer_names RPC 허용
    await expect(page.getByText("호흡과 정렬에 집중하는")).toBeVisible();
    await expect(page.locator(".class-detail-chips")).toContainText("하타 10회권");
    await expect(page.getByRole("link", { name: /다른 일정|7|월|화|수|목|금|토|일/ }).first()).toBeVisible();   // 같은 수업의 다른 일정(cls-2)
  });

  test("소개/장소가 없는 수업은 해당 섹션을 만들지 않는다 + 프라이빗 배지", async ({ page }) => {
    await mockSupabase(page, { loggedIn: true, hasPass: true });
    await page.goto("/center/c-near/class/cls-3");
    await expect(page.getByRole("heading", { name: "수업 소개" })).toHaveCount(0);
    await expect(page.locator(".class-detail-facts")).toContainText("2층 스튜디오");
    await expect(page.locator(".class-detail-badge")).toHaveText("프라이빗 1:1");
    await expect(page.locator(".class-detail-chips")).toContainText("모든 수강권 가능");
  });

  test("수강권 보유: 예약하기 → 예약 화면이 이 수업을 정확히 연다(openClassId/openDate/center)", async ({ page }) => {
    await mockSupabase(page, { loggedIn: true, hasPass: true });
    await page.goto("/center/c-near/class/cls-1");
    const link = page.getByRole("link", { name: "예약하기" });
    await expect(link).toHaveClass(/primary/);
    const href = new URL((await link.getAttribute("href"))!, "http://x");
    expect(href.pathname).toBe("/reservation");
    expect(href.searchParams.get("openClassId")).toBe("cls-1");
    expect(href.searchParams.get("center")).toBe("c-near");
    expect(href.searchParams.get("openDate")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test("수강권 없음: 예약하기 → 같은 Dialog, 구매하기 → 센터 구매 시트 + 이 수업 정보를 구매 후 복귀용으로 전달", async ({ page }) => {
    await mockSupabase(page, { loggedIn: true, hasPass: false });
    await page.goto("/center/c-near/class/cls-1");
    await page.getByRole("button", { name: "예약하기" }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog.getByRole("heading", { name: "수강권이 필요해요" })).toBeVisible();
    await dialog.getByRole("button", { name: "수강권 구매하기" }).click();
    await expect(page).toHaveURL(/\/center\/c-near\?buy=1&reserveClassId=cls-1&reserveDate=\d{4}-\d{2}-\d{2}&reserveCenter=c-near/);
  });

  test("딥링크 새로고침 · 뒤로가기 · 없는 수업", async ({ page }) => {
    await mockSupabase(page, { loggedIn: true, hasPass: true });
    await page.goto("/center/c-near");
    await openClassTab(page);
    await page.locator(".center-class-row").first().click();
    await page.waitForURL(/\/class\//);
    await page.reload();
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await page.getByRole("button", { name: "뒤로가기" }).click();            // 새로고침 뒤: 문서 referrer 기반 → 센터 상세
    await expect(page).toHaveURL(/\/center\/c-near$/);
    await page.waitForLoadState("networkidle");
    await page.goto("/center/c-near/class/nope");
    await expect(page.getByText("수업을 찾을 수 없어요")).toBeVisible();
  });
});

test.describe("홈 헤더 · 검색 · 하단 내비", () => {
  test("홈 최상단 문구는 '모하빗' (기존 문구 없음), 알림/로그인 버튼 정렬 유지", async ({ page }) => {
    await mockSupabase(page, { loggedIn: false });
    await page.goto("/");
    await expect(page.locator(".home-heading-row .location")).toHaveText("모하빗");
    await expect(page.getByText("오늘은 어떤 움직임을 찾나요")).toHaveCount(0);
    const h = (await page.locator(".home-heading-row .location").boundingBox())!; const l = (await page.getByRole("link", { name: "로그인" }).first().boundingBox())!;
    expect(Math.abs((h.y + h.height / 2) - (l.y + l.height / 2))).toBeLessThan(24);
  });

  test("검색 화면 상단 여백이 늘었고(제목-입력창 간격) 입력 포커스가 가능하다", async ({ page }) => {
    await mockSupabase(page);
    await page.goto("/search");
    const heading = (await page.locator(".discovery-heading h1").boundingBox())!;
    expect(heading.y).toBeGreaterThanOrEqual(30);
    const input = page.locator("#discovery-search");
    const ib = (await input.boundingBox())!;
    expect(ib.y - (heading.y + heading.height)).toBeGreaterThan(30);
    await input.focus(); await expect(input).toBeFocused();
  });

  test("하단 내비(모바일): 선택 탭은 네이비 pill + aria-current, 나머지는 회색, 블러 레이어는 클릭을 막지 않는다", async ({ page, isMobile }) => {
    test.skip(!isMobile || (page.viewportSize()?.width ?? 0) >= 768, "폰 폭 전용(태블릿 이상은 좌측 rail 내비)");
    await mockSupabase(page);
    await page.goto("/search");
    const active = page.locator(".bottom-nav .nav-item.active");
    await expect(active).toHaveCount(1);
    await expect(active).toHaveAttribute("aria-current", "page");
    expect(await active.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgb(10, 36, 70)");
    expect(await active.evaluate((el) => getComputedStyle(el).color)).toBe("rgb(255, 255, 255)");
    expect(await active.evaluate((el) => parseFloat(getComputedStyle(el).borderTopLeftRadius))).toBeGreaterThan(20);
    const inactive = page.locator(".bottom-nav .nav-item:not(.active)").first();
    expect(await inactive.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
    const sizes = await page.locator(".bottom-nav .nav-item").evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; }));
    expect(new Set(sizes.map((s) => s[1])).size).toBe(1); expect(sizes[0][1]).toBeGreaterThanOrEqual(44);
    const fade = page.locator(".bottom-nav-fade");
    expect(await fade.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe("none");
    const nav = (await page.locator(".bottom-nav").boundingBox())!;
    const hit = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest(".nav-item") !== null, [nav.x + nav.width * 0.62, nav.y + nav.height / 2]);
    expect(hit).toBe(true);                                                     // nav 위 클릭이 fade 가 아니라 탭에 닿는다
    const above = await page.evaluate(([x, y]) => { const el = document.elementFromPoint(x, y); return !!el && !el.classList.contains("bottom-nav-fade"); }, [nav.x + 10, nav.y - 12]);
    expect(above).toBe(true);
  });
});
