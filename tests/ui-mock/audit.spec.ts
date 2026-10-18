/* UX 감사 후속(UX-01~16) — 네트워크 목(mock) 기반. 실제 Supabase/결제에 접속하지 않는다. */
import { test, expect, type Page } from "@playwright/test";
import { mockSupabase, CLASSES } from "./support/mockSupabase";

const kstDate = (iso: string) => new Date(iso).toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" });
const cls1 = CLASSES.find((c) => c.id === "cls-1")!;
const openUrl = (extra = "") => `/reservation?openClassId=cls-1&openDate=${kstDate(cls1.start_time)}&center=c-near${extra}`;
const isMobile = (name: string) => name.startsWith("mobile");

async function search(page: Page, term: string) {
  await page.goto("/search");
  await page.locator("#discovery-search").fill(term);
  await expect(page.locator(".search-class-row").first()).toBeVisible();
}

test.describe("A·UX-01/05 — 탐색 상태와 뒤로가기", () => {
  test("검색 → 수업 상세(공개) → 뒤로가기: 검색어·결과 탭·오늘 필터가 그대로", async ({ page }) => {
    await mockSupabase(page);
    await search(page, "요가");
    await page.getByRole("button", { name: "수업", exact: true }).click();
    const first = page.locator(".search-class-row").first();
    expect(await first.getAttribute("href")).toMatch(/^\/center\/c-near\/class\/cls-/);   // 예약 화면이 아니라 공개 수업 상세
    await first.click();
    await expect(page).toHaveURL(/\/center\/c-near\/class\/cls-/);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await page.getByRole("button", { name: "뒤로가기" }).click();
    await expect(page).toHaveURL(/\/search/);
    await expect(page.locator("#discovery-search")).toHaveValue("요가");
    await expect(page.getByRole("button", { name: "수업", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".search-class-row").first()).toBeVisible();
  });

  test("브라우저 Back/Forward가 UI 뒤로가기와 같게 동작", async ({ page }) => {
    await mockSupabase(page);
    await search(page, "요가");
    await page.locator(".search-class-row").first().click();
    await expect(page).toHaveURL(/\/class\//);
    await page.goBack();
    await expect(page).toHaveURL(/\/search/);
    await expect(page.locator("#discovery-search")).toHaveValue("요가");
    await page.goForward();
    await expect(page).toHaveURL(/\/class\//);
  });

  test("'내 주변' 조건과 더보기·스크롤도 복원", async ({ page, context }) => {
    await context.grantPermissions(["geolocation"]);
    await context.setGeolocation({ latitude: 37.5745, longitude: 126.978 });
    await mockSupabase(page, { manyCenters: true });
    await page.goto("/search");
    await page.locator("#discovery-search").fill("센터");
    await expect(page.locator(".search-center-row").first()).toBeVisible();
    await page.getByRole("button", { name: /내 주변/ }).click();
    await expect(page.getByRole("button", { name: /내 주변/ })).toHaveAttribute("aria-pressed", "true");
    await page.locator(".search-center-row").first().click();
    await expect(page).toHaveURL(/\/center\//);
    await page.getByRole("button", { name: "뒤로가기" }).click();
    await expect(page).toHaveURL(/\/search/);
    await expect(page.getByRole("button", { name: /내 주변/ })).toHaveAttribute("aria-pressed", "true");
  });

  test("직접 진입한 수업 상세의 뒤로가기는 안전한 기본 경로(센터)로", async ({ page }) => {
    await mockSupabase(page);
    await page.goto("/center/c-near/class/cls-1");
    await page.getByRole("button", { name: "뒤로가기" }).click();
    await expect(page).toHaveURL(/\/center\/c-near$/);
  });
});

test.describe("A·하이드레이션 전 입력", () => {
  test("자바스크립트가 늦게 로드돼도 먼저 친 검색어로 검색이 시작된다(입력만 남고 결과가 없던 간헐 실패의 원인 재현·방지)", async ({ page, browserName }) => {
    test.skip(browserName !== "chromium", "라우트 지연 재현은 Chromium에서");
    await mockSupabase(page);
    await page.route("**/_next/static/**/*.js", async (route) => { await new Promise((r) => setTimeout(r, 1500)); await route.continue(); });   // 하이드레이션을 늦춘다
    await page.goto("/search", { waitUntil: "domcontentloaded" });
    await page.locator("#discovery-search").fill("요가");                      // 하이드레이션 전에 입력
    await expect(page.locator(".search-class-row").first()).toBeVisible({ timeout: 30_000 });
  });
});

test.describe("G·UX-08 — 결과 없음 원인 구분", () => {
  test("오늘 수업 필터가 0건의 원인이면 검색어 변경이 아니라 필터 해제를 안내", async ({ page }) => {
    await mockSupabase(page);
    await search(page, "요가");
    await page.getByRole("button", { name: "수업", exact: true }).click();
    await page.getByRole("button", { name: "오늘 수업" }).click();
    await expect(page.getByText("오늘 예정된 수업이 없어요")).toBeVisible();
    await expect(page.getByText("더 짧은 이름이나 다른 종목")).toHaveCount(0);
    await page.getByRole("button", { name: "오늘 조건 해제" }).click();
    await expect(page.locator(".search-class-row").first()).toBeVisible();
  });
});

test.describe("B·UX-02/03/04 — 공개 수업 상세와 예약 진입", () => {
  test("비로그인: 수업 정보 열람 + 로그인하고 예약(로그인 후 같은 수업으로 복귀)", async ({ page }) => {
    await mockSupabase(page);
    await page.goto("/center/c-near/class/cls-1");
    await expect(page.locator(".class-detail-facts")).toContainText("A룸");
    await expect(page.locator(".class-detail-facts")).toContainText("수업 시작 1시간 전까지 예약");
    await expect(page.getByRole("link", { name: "로그인하고 예약" })).toBeVisible();
  });

  test("수강권 없음: 이유 설명 + 사용 가능한 수강권 보기 / 닫기, 닫으면 초점 복귀", async ({ page }) => {
    await mockSupabase(page, { loggedIn: true });
    await page.goto("/center/c-near/class/cls-1");
    await expect(page.getByTestId("viewer-note")).toContainText("수강권");
    const trigger = page.getByRole("button", { name: "예약하기" });
    await trigger.click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog.getByRole("heading", { name: "이 수업은 수강권이 필요해요" })).toBeVisible();
    await expect(dialog).toContainText("하타 10회권");   // 이 수업에 쓸 수 있는 수강권(지정 수업)
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    if (test.info().project.name !== "mobile-webkit") await expect(trigger).toBeFocused();
  });

  test("보유했지만 조건 불일치 / 만료·소진은 각각 다른 이유", async ({ page }) => {
    await mockSupabase(page, { loggedIn: true, hasPass: true, usableNone: true });
    await page.goto("/center/c-near/class/cls-1");
    await page.getByRole("button", { name: "예약하기" }).click();
    await expect(page.getByRole("alertdialog").getByRole("heading", { name: "보유한 수강권을 이 수업에 쓸 수 없어요" })).toBeVisible();
    await page.unroute("**/*.supabase.co/**");
    await mockSupabase(page, { loggedIn: true, hasPass: true, exhaustedPass: true });
    await page.goto("/center/c-near/class/cls-1");
    await page.getByRole("button", { name: "예약하기" }).click();
    await expect(page.getByRole("alertdialog").getByRole("heading", { name: "사용할 수 있는 수강권이 없어요" })).toBeVisible();
  });

  test("유효 수강권: 이 수업·일정의 예약 단계로 연결 + 사용 가능한 수강권 표시", async ({ page }) => {
    await mockSupabase(page, { loggedIn: true, hasPass: true });
    await page.goto("/center/c-near/class/cls-1");
    await expect(page.getByTestId("usable-passes")).toContainText("하타 10회권");
    await expect(page.getByTestId("usable-passes")).toContainText("5회 남음");
    const href = new URL((await page.getByRole("link", { name: "예약하기" }).getAttribute("href"))!, "http://x");
    expect(href.searchParams.get("openClassId")).toBe("cls-1");
    expect(href.searchParams.get("openDate")).toBe(kstDate(cls1.start_time));
  });

  test("프로필별 판정: 프로필을 바꾸면 사용 가능 여부가 다시 계산되고 예약 링크에 프로필이 실린다", async ({ page }) => {
    await mockSupabase(page, { loggedIn: true, hasPass: true, twoProfiles: true, usableOnlyP2: true });
    await page.goto("/center/c-near/class/cls-1");
    const group = page.getByRole("group", { name: "예약할 프로필" });
    await expect(group.getByRole("button", { name: /가족B/ })).toHaveAttribute("aria-pressed", "true");   // 쓸 수 있는 프로필이 기본
    expect(await page.getByRole("link", { name: "예약하기" }).getAttribute("href")).toContain("profile=p2");
    await group.getByRole("button", { name: /회원A/ }).click();
    await expect(page.getByRole("link", { name: "예약하기" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "예약하기" })).toBeVisible();
    await expect(page.getByTestId("viewer-note")).toBeVisible();
  });

  test("수강권 없는 센터의 예약 딥링크(?openClassId)는 빈 달력이 아니라 공개 수업 상세로", async ({ page }) => {
    await mockSupabase(page, { loggedIn: true });
    await page.goto(openUrl());
    await expect(page).toHaveURL(/\/center\/c-near\/class\/cls-1$/);
    await expect(page.getByRole("heading", { level: 1, name: "아침 하타 요가" })).toBeVisible();
  });

  test("접근할 수 없거나 없는 수업의 딥링크는 명시적으로 안내", async ({ page }) => {
    await mockSupabase(page, { loggedIn: true });
    await page.goto(`/reservation?openClassId=nope&openDate=2026-12-01`);
    await expect(page.getByTestId("resv-class-missing")).toBeVisible();
    await expect(page.getByTestId("resv-class-missing")).toContainText("삭제됐거나 접근할 수 없는 수업");
  });
});

test.describe("C·UX-15 — 보유 수강권 → 예약 연결", () => {
  test("수업이 아직 없는 센터: 센터 이름·보유 수강권을 보이고 '등록된 수업 없음'으로 원인을 구분", async ({ page }) => {
    await mockSupabase(page, { loggedIn: true, emptyCenterPass: true });
    await page.goto("/reservation?center=c-empty-center");
    const ctx = page.getByTestId("resv-center-passes");
    await expect(ctx).toContainText("수업 준비 중 스튜디오");
    await expect(ctx).toContainText("[QA] UX 검증용 무료 3회권");
    await expect(ctx).toContainText("3회 남음");
    await expect(ctx).toContainText("기간 무제한");
    await expect(page.getByRole("button", { name: /센터 선택, 현재 수업 준비 중 스튜디오/ })).toBeVisible();   // 이름 없는 '센터'가 아니다
    await expect(page.getByTestId("resv-empty")).toHaveAttribute("data-reason", "center_no_classes");
    await expect(page.getByTestId("resv-empty")).toContainText("이 달에는 이 센터에 등록된 수업이 아직 없어요");
    await expect(page.getByRole("link", { name: "센터 보기" }).first()).toBeVisible();
  });
  test("읽을 수 없는 센터(비공개·미승인·삭제)는 이용 불가 사유와 다음 행동, 센터 목록은 넓히지 않는다", async ({ page }) => {
    await mockSupabase(page, { loggedIn: true });
    await page.goto("/reservation?center=c-private");
    await expect(page.getByTestId("resv-center-unavailable")).toContainText("지금 이용할 수 없어요");
    await expect(page.getByTestId("resv-empty")).toHaveAttribute("data-reason", "center_unavailable");
    await page.getByRole("button", { name: /센터 선택/ }).click();
    await expect(page.getByText("c-private")).toHaveCount(0);
  });
});

test.describe("E·UX-10 — 접힌 메뉴 접근성", () => {
  test("접힌 아이콘 메뉴 링크에 접근 가능한 이름과 현재 위치(aria-current)", async ({ page }) => {
    test.skip(isMobile(test.info().project.name), "데스크톱·태블릿 레일 전용");
    await mockSupabase(page);
    await page.goto("/search");
    const rail = page.locator(".member-desktop-nav");
    for (const name of ["홈", "찾기", "예약", "마이"]) await expect(rail.getByRole("link", { name, exact: true })).toBeVisible();
    await expect(rail.getByRole("link", { name: "찾기", exact: true })).toHaveAttribute("aria-current", "page");
    const nameless = await rail.locator("a").evaluateAll((els) => els.filter((e) => !(e.getAttribute("aria-label") || e.textContent || "").trim()).length);
    expect(nameless).toBe(0);
  });
  test("키보드로 메뉴 이동 + 초점 표시", async ({ page }) => {
    test.skip(isMobile(test.info().project.name) || test.info().project.name === "mobile-webkit", "데스크톱·태블릿 Chromium 전용");
    await mockSupabase(page);
    await page.goto("/search");
    const link = page.locator(".member-desktop-nav").getByRole("link", { name: "예약", exact: true });
    await link.focus();
    await expect(link).toBeFocused();
    const ring = await link.evaluate((e) => { const s = getComputedStyle(e); return `${s.outlineStyle}|${s.outlineWidth}|${s.boxShadow}`; });
    expect(ring).not.toBe("none|0px|none");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/reservation/);
  });
});

test.describe("F·UX-11/16 — 결제 문구와 무료 지급 표시", () => {
  test("센터 직접결제는 '주문 접수'로 말하고 총액은 '센터에서 결제할 금액'", async ({ page }) => {
    await mockSupabase(page, { loggedIn: true, checkoutProduct: true });
    await page.goto("/checkout?center=c-near&product=prod-long");
    await expect(page.locator(".checkout-order-name")).toContainText("매우 긴 이름");
    await expect(page.getByText("이 버튼은 주문만 접수하고 결제는 하지 않아요")).toBeVisible();
    await expect(page.locator(".checkout-total")).toContainText("센터에서 결제할 금액");
    const btn = page.locator(".checkout-pay-btn");
    await expect(btn).toContainText("주문 접수하기");
    await expect(btn).not.toContainText("결제하기");
    await expect(page.getByText("주문 접수 시", { exact: false })).toBeVisible();
  });

  test("390px: 상품명은 자연스럽게 줄바꿈되고 금액과 '원'은 한 줄로 붙어 있다(라이트·다크)", async ({ page }) => {
    test.skip(!isMobile(test.info().project.name), "좁은 화면 전용");
    await mockSupabase(page, { loggedIn: true, checkoutProduct: true });
    await page.goto("/checkout?center=c-near&product=prod-long");
    for (const theme of ["light", "charcoal"]) {
      await page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
      const price = page.locator(".checkout-order-price");
      await expect(price).toHaveText("160,000원");
      const box = (await price.boundingBox())!;
      const lh = await price.evaluate((e) => parseFloat(getComputedStyle(e).lineHeight) || 24);
      expect(box.height).toBeLessThan(lh * 1.6);                                   // '원'이 다음 줄로 떨어지지 않음
      const name = (await page.locator(".checkout-order-name").boundingBox())!;
      expect(box.y).toBeGreaterThanOrEqual(name.y + name.height - 2);                // 좁은 화면에서는 이름 아래 줄에 금액
      const tag = (await page.locator(".checkout-order-name .product-kind-tag").boundingBox())!;
      expect(tag.height).toBeLessThan(26);                                         // 배지가 두 줄로 쪼개지지 않음
      const right = await page.evaluate(() => { const r = document.querySelector(".checkout-order-price")!.getBoundingClientRect(); return window.innerWidth - r.right; });
      expect(right).toBeGreaterThanOrEqual(12);
    }
  });

  test("마이: 무료 지급 수강권은 '무료 지급' 표시 + 환불 버튼 없음, 유료 수강권은 기존 환불 경로 유지", async ({ page }) => {
    await mockSupabase(page, {
      loggedIn: true, hasPass: true, emptyCenterPass: true,
      payments: [{ membership_id: "m-free", sale_type: "service", total_amount: 0 }, { membership_id: "m1", sale_type: "new", total_amount: 160000 }],
    });
    await page.goto("/mypage");
    const free = page.locator(".membership-card", { hasText: "UX 검증용 무료 3회권" });
    await expect(free).toBeVisible();
    await expect(free.locator(".membership-origin-tag")).toHaveText("무료 지급");
    await expect(free.locator(".membership-refund")).toHaveCount(0);
    const paid = page.locator(".membership-card", { hasText: "하타 5회권" });
    await expect(paid.locator(".membership-origin-tag")).toHaveCount(0);
    const refund = paid.locator(".membership-refund");
    await expect(refund).toBeVisible();
    for (const theme of ["light", "charcoal"]) {   // 환불 버튼 글자가 배경에 묻히지 않는다(라이트에서 거의 보이지 않던 문제)
      await page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
      await page.waitForTimeout(400);
      const ratio = await refund.evaluate((e) => {
        const lum = (c: string) => { const m = c.match(/[\d.]+/g)!.map(Number); const f = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(m[0]) + 0.7152 * f(m[1]) + 0.0722 * f(m[2]); };
        const s = getComputedStyle(e); const fg = lum(s.color); const bg = lum(s.backgroundColor);
        return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
      });
      expect(ratio).toBeGreaterThan(4.5);
      expect((await refund.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
  });

  test("구매 내역: 무료 지급은 금전 환불 대신 안내, 주문을 못 찾은 유료 건을 '무료'라고 하지 않는다", async ({ page }) => {
    await mockSupabase(page, {
      loggedIn: true, hasPass: true, emptyCenterPass: true,
      payments: [{ membership_id: "m-free", sale_type: "service", total_amount: 0 }, { membership_id: "m1", sale_type: "new", total_amount: 160000 }],
    });
    await page.goto("/purchases");
    const free = page.locator(".purchase-item", { hasText: "UX 검증용 무료 3회권" });
    await expect(free.locator(".purchase-meta")).toContainText("무료 지급");
    await expect(free.getByRole("button", { name: "환불하기" })).toHaveCount(0);
    await expect(free.locator(".purchase-refund-note")).toContainText("환불 대상이 아니에요");
    const paid = page.locator(".purchase-item", { hasText: "하타 5회권" });
    await expect(paid.locator(".purchase-meta")).not.toContainText("무료");
    await expect(paid.getByRole("button", { name: "환불하기" })).toBeVisible();
  });
});
