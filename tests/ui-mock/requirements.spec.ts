/* 최초 요구사항 9개 대조용 브라우저 검증(네트워크 mock). 실제 DB 검증은 tests/ui-real(격리 PostgREST)과 구분한다. */
import { expect, test, type Page } from "@playwright/test";
import { mockSupabase } from "./support/mockSupabase";

const CAT = "/category/%EC%9A%94%EA%B0%80";
const noHScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test.describe("요구사항 1·2 — 필터/정렬/센터 정보 (반응형 폭)", () => {
  test.use({ geolocation: { latitude: 37.5665, longitude: 126.978 }, permissions: ["geolocation"] });
  for (const width of [375, 390, 768, 1024, 1440]) {
    test(`폭 ${width}px: 긴 센터명·긴 주소·정보 없는 센터에서도 가로 넘침 없음, 정보 위치(이름 오른쪽=넓은 화면 / 아래 줄=좁은 화면)`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await mockSupabase(page, { longAddress: true });
      await page.goto(`${CAT}?s=distance`);
      await expect(page.locator(".cat-center-card")).toHaveCount(5);
      expect(await noHScroll(page)).toBeLessThanOrEqual(0);
      const card = page.locator(".cat-center-card", { hasText: "하늘 요가" });
      const name = (await card.locator(".cat-center-name").boundingBox())!, meta = (await card.locator(".cat-center-meta").boundingBox())!;
      if (width >= 1024) { expect(meta.x).toBeGreaterThan(name.x + 40); expect(Math.abs(meta.y - name.y)).toBeLessThan(30); }   // 이름 오른쪽(같은 줄)
      else { expect(meta.y).toBeGreaterThan(name.y + name.height - 4); }                                                        // 이름 아래 줄
      const long = page.locator(".cat-center-card", { hasText: "긴주소센터" });
      const lm = (await long.locator(".cat-center-meta").boundingBox())!, lc = (await long.boundingBox())!;
      expect(lm.x + lm.width).toBeLessThanOrEqual(lc.x + lc.width + 1);
      await expect(page.locator(".cat-center-card", { hasText: "다온 요가" }).locator(".cat-center-meta")).toHaveCount(0);
    });
  }
  test("평점이 없는 센터는 0점이 아니라 평점 영역이 없고, 평점순에서는 맨 뒤", async ({ page }) => {
    await mockSupabase(page);
    await page.goto(`${CAT}?s=rating`);
    await expect(page.locator(".cat-center-card")).toHaveCount(4);
    await expect(page.locator(".cat-center-card", { hasText: "가람 요가" })).not.toContainText("0.0");
    await expect(page.locator(".cat-center-card", { hasText: "가람 요가" }).locator(".cat-meta-rating")).toHaveCount(0);
  });
  test("반경 경계: 1km=가까운 1곳, 20km=좌표 있는 전부 / 필터 초기화 / 복귀 후 URL 상태", async ({ page }) => {
    await mockSupabase(page);
    await page.goto(`${CAT}?r=1`);
    await expect(page.locator(".cat-center-card")).toHaveCount(1);
    await page.goto(`${CAT}?r=20&s=name`);
    await expect(page.locator(".cat-center-card")).toHaveCount(3);                       // 좌표 없는 1곳 제외
    await page.getByRole("button", { name: "초기화" }).first().click();
    await expect(page.locator(".cat-center-card")).toHaveCount(4);
    await expect(page).toHaveURL(/\/category\/[^?]*$/);
  });
});

test.describe("요구사항 1 — 위치 실패 유형", () => {
  test("GPS 실패(PERMISSION이 아닌 POSITION_UNAVAILABLE/TIMEOUT) → 안내 + 다시 시도, 목록은 전체", async ({ page }) => {
    await mockSupabase(page);
    await page.addInitScript(() => { Object.defineProperty(navigator, "geolocation", { value: { getCurrentPosition: (_ok: unknown, err: (e: { code: number }) => void) => setTimeout(() => err({ code: 2 }), 20), watchPosition: () => 0, clearWatch: () => {} }, configurable: true }); });
    await page.goto(CAT);
    await page.getByRole("button", { name: /검색 조건/ }).click();
    await page.getByRole("radio", { name: "5km" }).click();
    await expect(page.getByText(/현재 위치를 확인하지 못했어요/).first()).toBeVisible();
    await page.getByRole("button", { name: /^적용/ }).click();
    await expect(page.locator(".cat-center-card")).toHaveCount(4);
    await expect(page.getByRole("button", { name: "다시 시도" }).first()).toBeVisible();
  });
});

test.describe("요구사항 5 — 필터 시트 UI", () => {
  test.use({ geolocation: { latitude: 37.5665, longitude: 126.978 }, permissions: ["geolocation"] });
  test("검색 조건 → 시트: 거리/정렬/초기화/적용, 선택 즉시 목록 반영, 시트가 화면 안, 터치 영역≥44, ESC/포커스, 새로고침·뒤로가기 후 유지", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 640 });                 // 작은 화면 높이
    await mockSupabase(page);
    await page.goto(CAT);
    await expect(page.locator(".cat-center-card")).toHaveCount(4);
    await page.getByRole("button", { name: /검색 조건/ }).click();
    const sheet = page.locator(".center-filter-sheet");
    await expect(sheet).toBeVisible();
    const sb = (await sheet.boundingBox())!;
    expect(sb.y).toBeGreaterThanOrEqual(0); expect(sb.y + sb.height).toBeLessThanOrEqual(640 + 1);
    for (const loc of [sheet.getByRole("radio").first(), sheet.getByRole("button", { name: "초기화" }), sheet.getByRole("button", { name: /^적용/ })]) { const b = (await loc.boundingBox())!; expect(b.height).toBeGreaterThanOrEqual(44); }
    await sheet.getByRole("radio", { name: "5km" }).click();
    await expect(page.locator(".cat-center-card")).toHaveCount(2);           // 닫지 않아도 즉시 반영
    await sheet.getByRole("radio", { name: /이름순/ }).click();
    await expect(page).toHaveURL(/r=5/); await expect(page).toHaveURL(/s=name/);
    await sheet.getByRole("button", { name: "초기화" }).click();
    await expect(page.locator(".cat-center-card")).toHaveCount(4); await expect(page).not.toHaveURL(/r=|s=/);
    await sheet.getByRole("radio", { name: "10km" }).click();
    await sheet.getByRole("button", { name: /^적용/ }).click();
    await expect(sheet).toHaveCount(0);
    await page.reload();
    await page.waitForLoadState("networkidle");   // 하이드레이션/조회 완료 전 단언으로 생기던 간헐 실패(느린 dev 서버·태블릿) 방지
    await expect(page.getByRole("button", { name: /거리 10km/ })).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: /검색 조건/ }).click(); await page.keyboard.press("Escape");
    await expect(page.locator(".center-filter-sheet")).toHaveCount(0);
    if (test.info().project.name !== "mobile-webkit") await expect(page.getByRole("button", { name: /검색 조건/ })).toBeFocused();   // 포커스 복귀 (Safari/WebKit은 버튼 클릭 시 포커스가 가지 않는 것이 기본 동작이라 복귀할 대상이 없다)
  });
});

test.describe("요구사항 4 — 홈 상단 문구", () => {
  for (const loggedIn of [false, true]) {
    test(`로그인=${loggedIn}: 항상 '모하빗', 이전 문구 없음(다크 포함)`, async ({ page }) => {
      await mockSupabase(page, { loggedIn });
      await page.goto("/");
      await expect(page.locator(".home-heading-row .location")).toHaveText("모하빗");
      await page.evaluate(() => document.documentElement.setAttribute("data-theme", "charcoal"));
      await expect(page.getByText(/오늘은 어떤 움직임|다음 수업을 확인해요/)).toHaveCount(0);
    });
  }
});

test.describe("요구사항 3 — 하단 내비 세부", () => {
  test.beforeEach(({}, info) => { test.skip(!info.project.use.isMobile || (info.project.use.viewport?.width ?? 0) >= 768, "폰 폭 전용"); });
  test("블러는 점진적(마스크)·pointer-events none, 키보드가 열리면 내비+블러 숨김, 시트(z-index)가 내비 위, 다크 모드 pill 대비", async ({ page }) => {
    await mockSupabase(page);
    await page.goto("/search");
    const fade = page.locator(".bottom-nav-fade");
    const st = await fade.evaluate((el) => { const c = getComputedStyle(el); return { mask: c.maskImage || c.getPropertyValue("-webkit-mask-image"), bf: c.backdropFilter || c.getPropertyValue("-webkit-backdrop-filter"), z: +c.zIndex, pe: c.pointerEvents, bg: c.backgroundImage }; });
    expect(st.mask).toContain("linear-gradient"); expect(st.mask).toMatch(/transparent|rgba\(0, 0, 0, 0\)/);   // 위로 갈수록 사라지는 마스크(균일 blur 아님)
    expect(st.bf).toContain("blur"); expect(st.pe).toBe("none"); expect(st.bg).toContain("gradient");
    const navZ = +(await page.locator(".bottom-nav").evaluate((el) => getComputedStyle(el).zIndex));
    expect(st.z).toBeLessThan(navZ); expect(navZ).toBeLessThan(60);                               // 시트/모달(60+) 아래
    // 키보드 표시 시뮬레이션: visualViewport 높이를 줄이고 resize 이벤트
    await page.evaluate(() => { const vv = window.visualViewport!; Object.defineProperty(vv, "height", { get: () => window.innerHeight - 320, configurable: true }); vv.dispatchEvent(new Event("resize")); });
    await expect(page.locator(".bottom-nav")).toHaveClass(/keyboard-hidden/);
    await expect(fade).toHaveClass(/keyboard-hidden/);
    await expect.poll(() => page.locator(".bottom-nav").evaluate((el) => getComputedStyle(el).visibility)).toBe("hidden");   // 160ms 전환 뒤
    await page.evaluate(() => { const vv = window.visualViewport!; Object.defineProperty(vv, "height", { get: () => window.innerHeight, configurable: true }); vv.dispatchEvent(new Event("resize")); });
    await expect(page.locator(".bottom-nav")).not.toHaveClass(/keyboard-hidden/);
    // 다크 모드 pill: 흰 글자 대비 4.5 이상
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "charcoal")); await page.waitForTimeout(400);
    const [bg, fg] = await page.locator(".bottom-nav .nav-item.active").evaluate((el) => { const c = getComputedStyle(el); return [c.backgroundColor, c.color]; });
    const lum = (rgb: string) => { const [r, g, b] = rgb.match(/\d+/g)!.slice(0, 3).map(Number).map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    const ratio = (lum(fg) + 0.05) / (lum(bg) + 0.05); expect(ratio).toBeGreaterThanOrEqual(4.5);
  });
  test("시트가 열리면 내비·블러 위에 오버레이가 덮는다(클릭이 오버레이에 닿음)", async ({ page }) => {
    await mockSupabase(page, { loggedIn: true });
    await page.goto("/center/c-near");
    await page.getByRole("button", { name: "수강권 구매하기" }).last().click();
    await expect(page.locator(".sheet-overlay").first()).toBeVisible();
    const nav = (await page.locator(".bottom-nav").boundingBox())!;
    const top = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest(".sheet-overlay, .bottom-nav") ?.className ?? "", [nav.x + nav.width * 0.62, nav.y + nav.height / 2]);
    expect(String(top)).toContain("sheet-overlay");
  });
});

test.describe("요구사항 6 — 수업 상세 상태", () => {
  test("폐강/정원 마감/없는 수업/비로그인", async ({ page }) => {
    await mockSupabase(page, { loggedIn: true, hasPass: true });
    await page.goto("/center/c-near/class/cls-4");                                 // 폐강
    await expect(page.getByText("폐강된 수업이에요")).toBeVisible();
    await expect(page.getByRole("button", { name: "예약하기" })).toBeDisabled();
    await page.goto("/center/c-near/class/cls-5");                                 // 정원 마감
    await expect(page.locator(".class-detail-facts")).toContainText("정원 마감(대기 가능)");
    await expect(page.getByRole("link", { name: "예약하기" })).toBeVisible();      // 대기 예약은 기존 예약 화면이 처리
    await page.goto("/center/c-near/class/nope");
    await expect(page.getByText("수업을 찾을 수 없어요")).toBeVisible();
    await page.goto("/center/c-far/class/cls-1");                                  // 센터-수업 불일치
    await expect(page.getByText("수업을 찾을 수 없어요")).toBeVisible();
  });
  test("비로그인: 상세는 보이고 CTA는 '로그인하고 예약'(같은 수업으로 복귀), 수강권 보기 링크는 이 수업 복귀 정보 포함", async ({ page }) => {
    await mockSupabase(page, { loggedIn: false });
    await page.goto("/center/c-near/class/cls-1");
    await expect(page.getByRole("heading", { level: 1, name: "아침 하타 요가" })).toBeVisible();
    await expect(page.getByTestId("viewer-note")).toContainText("수업 내용은 로그인 없이 볼 수 있어요");
    const login = page.getByRole("link", { name: "로그인하고 예약" });
    await expect(login).toBeVisible();
    expect(decodeURIComponent((await login.getAttribute("href"))!)).toBe("/login?next=/center/c-near/class/cls-1");
    expect(await page.getByRole("link", { name: "수강권 보기" }).getAttribute("href")).toContain("reserveClassId=cls-1");
  });
});

test.describe("요구사항 7 — 뒤로가기 경로별", () => {
  test("검색 결과 → 센터 → 뒤로가기: 검색 화면과 검색어 복원", async ({ page }) => {
    await mockSupabase(page);
    await page.goto("/search");
    await page.waitForLoadState("networkidle");   // 하이드레이션 전에 입력하면 검색이 시작되지 않는 WebKit 간헐 실패 방지
    await page.locator("#discovery-search").fill("요가");
    await expect(page.locator(".search-center-row").first()).toBeVisible();
    await page.locator(".search-center-row").first().click();
    await expect(page).toHaveURL(/\/center\//);
    await page.getByRole("button", { name: "뒤로가기" }).click();
    await expect(page).toHaveURL(/\/search/);
    await expect(page.locator("#discovery-search")).toHaveValue("요가");
  });
  test("홈 추천 수업 → 센터 → 뒤로가기: 홈으로", async ({ page }) => {
    await mockSupabase(page, { loggedIn: true });
    await page.goto("/");
    const row = page.locator(".home-class-row").first();
    await expect(row).toBeVisible();
    await row.click();
    await expect(page).toHaveURL(/\/center\//);
    await page.getByRole("button", { name: "뒤로가기" }).click();
    await expect(page).toHaveURL(/localhost:\d+\/$/);
  });
  test("종목 목록(필터) → 센터 → 새로고침 → 뒤로가기: 같은 종목 목록·필터 복원", async ({ page }) => {
    await mockSupabase(page);
    await page.goto(`${CAT}?s=name`);
    await page.locator(".cat-center-card").first().click();
    await expect(page).toHaveURL(/\/center\//);
    await page.reload();
    await page.getByRole("button", { name: "뒤로가기" }).click();
    await expect(page).toHaveURL(/\/category\/.*s=name/);
  });
  test("종목 목록 → 센터 → 수업 탭 → 수업 상세 → 뒤로가기 ×2 → 목록", async ({ page }) => {
    await mockSupabase(page, { loggedIn: true, hasPass: true });
    await page.goto(CAT);
    await page.locator(".cat-center-card").first().click();
    await page.getByRole("button", { name: "수업", exact: true }).click();
    await page.locator(".center-class-row").first().click();
    await expect(page).toHaveURL(/\/class\//);
    await page.getByRole("button", { name: "뒤로가기" }).click();
    await expect(page).toHaveURL(/\/center\/[^/]+$/);
    await page.getByRole("button", { name: "뒤로가기" }).click();
    await expect(page).toHaveURL(/\/category\//);
  });
});

test.describe("요구사항 8·9 — CTA/공유/팝업 접근성", () => {
  test("긴 센터명: 공유 버튼 gutter, CTA와 내비 겹침 없음, 터치 영역, 팝업 포커스(닫기 버튼 초점·Tab 순환), 비로그인도 동일 팝업", async ({ page }) => {
    await mockSupabase(page, { loggedIn: false });
    await page.goto("/center/c-far");
    const cta = (await page.locator(".center-bottom-bar").boundingBox())!;
    const navLoc = page.locator(".bottom-nav");
    if (await navLoc.isVisible()) { const nav = (await navLoc.boundingBox())!; expect(cta.y + cta.height).toBeLessThanOrEqual(nav.y + 2); }
    for (const name of ["수강권 구매하기", "예약하기"]) { const b = (await page.getByRole("button", { name }).last().boundingBox())!; expect(b.height).toBeGreaterThanOrEqual(44); }
    await page.getByRole("button", { name: "예약하기" }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog.getByRole("heading", { name: "수강권이 필요해요" })).toBeVisible();
    await expect(dialog).toContainText("이 센터의 수강권을 먼저 구매해주세요.");
    await expect(dialog.getByRole("button", { name: "닫기" })).toBeFocused();
    if (test.info().project.name !== "mobile-webkit") {   // Safari/WebKit 기본 설정은 Tab이 버튼을 건너뛴다(Full Keyboard Access 필요) — Tab 순환은 Chromium에서 검증
      await page.keyboard.press("Tab"); await expect(dialog.getByRole("button", { name: "수강권 구매하기" })).toBeFocused();
      await page.keyboard.press("Tab"); await expect(dialog.getByRole("button", { name: "닫기" })).toBeFocused();   // 포커스 트랩 순환
    }
    await expect(page.locator(".error-toast")).toHaveCount(0);
    await page.keyboard.press("Escape"); await expect(dialog).toHaveCount(0);
    if (test.info().project.name !== "mobile-webkit") await expect(page.getByRole("button", { name: "예약하기" })).toBeFocused();   // 닫으면 트리거로 복귀
  });
  test("모바일 뒤로가기(브라우저 back)로 팝업 이후 화면 이동이 깨지지 않는다 — 팝업 열림 중 뒤로가기는 이전 화면", async ({ page }) => {
    await mockSupabase(page);
    await page.goto(CAT);
    await page.locator(".cat-center-card").first().click();
    await page.getByRole("button", { name: "예약하기" }).click();
    await expect(page.getByRole("alertdialog")).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(/\/category\//);
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
  });
});

test.describe("요구사항 6 — 수업 상세의 운영 권한 차이(비로그인/로그인)", () => {
  const ALL = "모든 수강권 가능";
  test("비로그인 + 지정(selected) 수업: RLS 로 허용 목록이 비어 보여도 '모든 수강권 가능'이라고 말하지 않고 로그인 안내, 강사 RPC 권한 오류는 '없음'이 아니라 로그인 안내", async ({ page }) => {
    await mockSupabase(page, { loggedIn: false });
    await page.goto("/center/c-near/class/cls-1");
    await expect(page.getByRole("heading", { level: 1, name: "아침 하타 요가" })).toBeVisible();
    await expect(page.getByTestId("allowed-passes-note")).toHaveText("이용 가능한 수강권은 로그인 후 확인해 주세요.");
    await expect(page.locator(".class-detail-v2")).not.toContainText(ALL);
    await expect(page.locator(".class-detail-chips .class-pass-chip")).toHaveCount(0);
    await expect(page.locator(".class-detail-facts")).toContainText("담당 강사");
    await expect(page.locator(".class-detail-facts")).toContainText("로그인 후 확인할 수 있어요");
    await expect(page.locator(".class-detail-facts")).toContainText("10명 · 6자리 남음");     // 공개 정보(정원/예약 인원)는 그대로
    await expect(page.getByText("호흡과 정렬에 집중하는")).toBeVisible();
  });
  test("로그인 + 지정 수업: 허용 수강권 칩과 강사 표시", async ({ page }) => {
    await mockSupabase(page, { loggedIn: true });
    await page.goto("/center/c-near/class/cls-1");
    await expect(page.locator(".class-detail-chips")).toContainText("하타 10회권");
    await expect(page.locator(".class-detail-v2")).not.toContainText(ALL);
    await expect(page.locator(".class-detail-facts")).toContainText("김하늘, 이가람");
    await expect(page.getByTestId("allowed-passes-note")).toHaveCount(0);
  });
  test("로그인 + 지정 수업인데 읽힌 목록이 비어 있음 / 조회 오류: 모두 가능이라고 하지 않고 확인 불가·불러오지 못함을 구분해 안내", async ({ page }) => {
    await mockSupabase(page, { loggedIn: true, emptyAllowed: true });
    await page.goto("/center/c-near/class/cls-1");
    await expect(page.getByTestId("allowed-passes-note")).toContainText("지정된 수강권을 확인할 수 없어요");
    await expect(page.locator(".class-detail-v2")).not.toContainText(ALL);
    await mockSupabase(page, { loggedIn: true, allowedFail: true });
    await page.goto("/center/c-near/class/cls-1");
    await expect(page.getByTestId("allowed-passes-note")).toContainText("불러오지 못했어요");
    await expect(page.locator(".class-detail-v2")).not.toContainText(ALL);
  });
  test("전체(all) 수업은 로그인 여부와 관계없이 '모든 수강권 가능'", async ({ page }) => {
    for (const loggedIn of [false, true]) {
      await mockSupabase(page, { loggedIn });
      await page.goto("/center/c-near/class/cls-2");
      await expect(page.locator(".class-detail-chips")).toContainText(ALL);
    }
  });
});
