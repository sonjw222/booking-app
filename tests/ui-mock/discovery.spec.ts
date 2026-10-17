import { expect, test } from "@playwright/test";
import { CENTERS, mockSupabase } from "./support/mockSupabase";

const SEOUL = { latitude: 37.5665, longitude: 126.978 };
const names = async (page: import("@playwright/test").Page) => page.locator(".cat-center-name").allTextContents();

test.describe("종목별 센터 목록 — 필터·정렬·상태 유지", () => {
  test.use({ geolocation: SEOUL, permissions: ["geolocation"] });

  test("기본 목록(추천순)은 서버 순서, 거리/정렬 칩이 보이고 검색창으로 이동하지 않는다", async ({ page }) => {
    await mockSupabase(page);
    await page.goto("/category/%EC%9A%94%EA%B0%80");
    await expect(page.locator(".cat-center-card")).toHaveCount(CENTERS.length);
    expect((await names(page))[0]).toContain("하늘 요가");
    await expect(page.getByRole("button", { name: /거리 전체/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /정렬: 추천순/ })).toBeVisible();
    await expect(page.getByRole("link", { name: /검색 조건/ })).toHaveCount(0);
  });

  test("거리 5km 선택 → 즉시 갱신 · URL 반영 · 좌표 없는 센터 제외 안내, 새로고침해도 유지", async ({ page }) => {
    await mockSupabase(page);
    await page.goto("/category/%EC%9A%94%EA%B0%80");
    await page.getByRole("button", { name: /거리 전체/ }).click();
    await page.getByRole("radio", { name: "5km" }).click();
    await page.getByRole("button", { name: /곳 보기/ }).click();
    await expect(page).toHaveURL(/r=5/);
    await expect(page.locator(".cat-center-card")).toHaveCount(2);
    await expect(page.getByText(/위치 정보가 등록되지 않은 센터 1곳/)).toBeVisible();
    await page.reload();
    await expect(page.locator(".cat-center-card")).toHaveCount(2);
    await expect(page.getByRole("button", { name: /거리 5km/ })).toBeVisible();
  });

  test("평점 높은 순 / 이름순 / 거리순", async ({ page }) => {
    await mockSupabase(page);
    await page.goto("/category/%EC%9A%94%EA%B0%80?s=rating");
    await expect(page.locator(".cat-center-card")).toHaveCount(4);
    const byRating = await names(page);
    expect(byRating[0]).toContain("나무 요가");      // 평균 4.7 (3건)
    expect(byRating[1]).toContain("하늘 요가");      // 평균 4.5 (2건)
    expect(byRating.slice(2).join("|")).toContain("가람");  // 평점 없는 센터는 뒤
    await page.goto("/category/%EC%9A%94%EA%B0%80?s=name");
    await expect(page.locator(".cat-center-card")).toHaveCount(4);
    expect((await names(page)).map((n) => n.slice(0, 2))).toEqual(["가람", "나무", "다온", "하늘"]);
    await page.goto("/category/%EC%9A%94%EA%B0%80?s=distance");
    await expect(page.locator(".cat-center-meta .cat-meta-distance").first()).toBeVisible();
    await expect(page.locator(".cat-center-card")).toHaveCount(4);
    expect((await names(page))[0]).toContain("하늘 요가");
    expect((await names(page)).at(-1)).toContain("다온");       // 거리 모르는 센터는 맨 뒤
  });

  test("평점·거리·지역은 실제 값이 있을 때만 표시, 평점 없는 센터에는 평점 UI가 없다", async ({ page }) => {
    await mockSupabase(page);
    await page.goto("/category/%EC%9A%94%EA%B0%80?s=distance");
    const near = page.locator(".cat-center-card", { hasText: "하늘 요가" });
    await expect(near.locator(".cat-meta-rating")).toContainText("4.5");
    await expect(near.locator(".cat-meta-distance")).toBeVisible();
    await expect(near.locator(".cat-meta-area")).toHaveText("서울 중구");
    const mid = page.locator(".cat-center-card", { hasText: "가람 요가" });
    await expect(mid.locator(".cat-meta-rating")).toHaveCount(0);
    const nocoord = page.locator(".cat-center-card", { hasText: "다온 요가" });
    await expect(nocoord.locator(".cat-center-meta")).toHaveCount(0);   // 주소·좌표·평점 모두 없음 → 가짜 정보 없음
  });

  test("후기 데이터가 없으면 평점순은 비활성 + 사유 안내(가짜 평점 없음)", async ({ page }) => {
    await mockSupabase(page, { noReviews: true });
    await page.goto("/category/%EC%9A%94%EA%B0%80");
    await page.getByRole("button", { name: /정렬: 추천순/ }).click();
    const rating = page.getByRole("radio", { name: /평점 높은 순/ });
    await expect(rating).toBeDisabled();
    await expect(page.getByText("아직 등록된 평점이 없어요")).toBeVisible();
    await expect(page.locator(".cat-meta-rating")).toHaveCount(0);
  });

  test("평점 조회 실패해도 목록은 보이고 평점순만 비활성", async ({ page }) => {
    await mockSupabase(page, { reviewsFail: true });
    await page.goto("/category/%EC%9A%94%EA%B0%80");
    await expect(page.locator(".cat-center-card")).toHaveCount(4);
    await page.getByRole("button", { name: /정렬: 추천순/ }).click();
    await expect(page.getByRole("radio", { name: /평점 높은 순/ })).toBeDisabled();
    await expect(page.getByText("평점 정보를 불러오지 못했어요")).toBeVisible();
  });

  test("검색어 + 조건 결과가 없으면 빈 상태 + 초기화", async ({ page }) => {
    await mockSupabase(page);
    await page.goto("/category/%EC%9A%94%EA%B0%80");
    await page.getByLabel(/센터 이름·주소 검색/).fill("존재하지않는센터");
    await expect(page.getByText(/에 맞는 센터가 없어요/)).toBeVisible();
    await expect(page).toHaveURL(/q=/);
    await page.getByRole("button", { name: "조건 초기화" }).click();
    await expect(page.locator(".cat-center-card")).toHaveCount(4);
    await expect(page).not.toHaveURL(/q=/);
  });

  test("네트워크 오류 상태 → 다시 시도", async ({ page }) => {
    await mockSupabase(page, { failCenters: true });
    await page.goto("/category/%EC%9A%94%EA%B0%80");
    await expect(page.getByText("센터를 불러오지 못했어요")).toBeVisible();
    await expect(page.getByRole("button", { name: "다시 시도" })).toBeVisible();
  });

  test("센터 상세에서 뒤로가기(화면 내 버튼/브라우저) → 같은 종목·거리·정렬·스크롤 복원", async ({ page }) => {
    await mockSupabase(page);
    await page.goto("/category/%EC%9A%94%EA%B0%80?r=10&s=name");
    const first = page.locator(".cat-center-card").first();
    await expect(first).toBeVisible();
    await first.click();
    await expect(page).toHaveURL(/\/center\//);
    await page.getByRole("button", { name: "뒤로가기" }).click();
    await expect(page).toHaveURL(/\/category\/.*r=10.*s=name|\/category\/.*s=name.*r=10/);
    await expect(page.getByRole("button", { name: /거리 10km/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /정렬: 이름순/ })).toBeVisible();
    // 브라우저 뒤로가기도 동일
    await page.locator(".cat-center-card").first().click();
    await expect(page).toHaveURL(/\/center\//);
    await page.goBack();
    await expect(page).toHaveURL(/\/category\//);
    await expect(page.getByRole("button", { name: /거리 10km/ })).toBeVisible();
  });

  test("센터 상세 직접 URL 진입 → 뒤로가기는 홈(폴백), 앱 밖으로 나가지 않는다", async ({ page }) => {
    await mockSupabase(page);
    await page.goto("/center/c-near");
    await page.getByRole("button", { name: "뒤로가기" }).click();
    await expect(page).toHaveURL(/localhost:\d+\/$/);
  });
});

test.describe("위치 권한 거부", () => {
  test.use({ permissions: [] });
  test("거리 범위를 고르면 안내 + 다시 시도 + 위치 없이 보기, 목록은 전체 유지", async ({ page, context }) => {
    await context.grantPermissions([]);
    await mockSupabase(page);
    await page.addInitScript(() => {
      // 권한 거부 시뮬레이션: getCurrentPosition 이 PERMISSION_DENIED(1)로 실패
      Object.defineProperty(navigator, "geolocation", { value: { getCurrentPosition: (_ok: unknown, err: (e: { code: number }) => void) => setTimeout(() => err({ code: 1 }), 20), watchPosition: () => 0, clearWatch: () => {} }, configurable: true });
    });
    await page.goto("/category/%EC%9A%94%EA%B0%80");
    await page.getByRole("button", { name: /거리 전체/ }).click();
    await page.getByRole("radio", { name: "3km" }).click();
    await expect(page.getByText(/위치 권한이 꺼져 있어/).first()).toBeVisible();
    await page.getByRole("button", { name: /곳 보기/ }).click();
    await expect(page.locator(".cat-center-card")).toHaveCount(4);                 // 거리 조건 미적용 + 전체 표시
    await expect(page.getByText(/지금은 전체 센터를 보여드려요/)).toBeVisible();
    await page.getByRole("button", { name: "위치 없이 보기" }).click();
    await expect(page).not.toHaveURL(/r=3/);
    await expect(page.getByRole("button", { name: /거리 전체/ })).toBeVisible();
  });
});
