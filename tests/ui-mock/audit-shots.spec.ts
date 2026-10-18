/* 수정 전/후 화면 증빙(SHOTS_DIR 지정 시에만 실행) — 프로덕션 빌드 + 네트워크 목. 개발용 오버레이가 없다. */
import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import { mockSupabase, CLASSES } from "./support/mockSupabase";

const DIR = process.env.SHOTS_DIR;
test.skip(!DIR, "SHOTS_DIR 미지정");
const kst = (iso: string) => new Date(iso).toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" });
const cls1 = CLASSES.find((c) => c.id === "cls-1")!;
const sizes = { m390: { width: 390, height: 844 }, t768: { width: 768, height: 1024 }, d1440: { width: 1440, height: 900 } } as const;

async function shot(page: Page, name: string, theme: string, size: string) {
  fs.mkdirSync(DIR!, { recursive: true });
  await page.evaluate((t) => document.documentElement.setAttribute("data-theme", t), theme);
  await page.waitForTimeout(450);
  await page.screenshot({ path: `${DIR}/${size}-${theme === "light" ? "light" : "dark"}-${name}.png` });
}

for (const [sizeName, viewport] of Object.entries(sizes)) {
  for (const theme of ["light", "charcoal"]) {
    test.describe(`${sizeName}/${theme}`, () => {
      test.use({ viewport });
      test("flows", async ({ page }) => {
        test.setTimeout(120_000);
        // 1) 수업 상세 — 비로그인
        await mockSupabase(page);
        await page.goto("/center/c-near/class/cls-1"); await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
        await shot(page, "01-class-anon", theme, sizeName);
        await page.getByRole("button", { name: "예약하기" }).or(page.getByRole("link", { name: "로그인하고 예약" })).first().scrollIntoViewIfNeeded();
        // 2) 수강권 없는 회원 — 예약하기 → 안내
        await page.unroute("**/*.supabase.co/**"); await mockSupabase(page, { loggedIn: true });
        await page.goto("/center/c-near/class/cls-1"); await expect(page.getByTestId("viewer-note")).toBeVisible();
        await page.getByRole("button", { name: "예약하기" }).click(); await expect(page.getByRole("alertdialog")).toBeVisible();
        await shot(page, "02-class-nopass-dialog", theme, sizeName);
        // 3) 수강권 없는 회원이 검색 결과 수업의 예약 딥링크로 → (수정 전: 빈 달력 / 수정 후: 수업 상세)
        await page.goto(`/reservation?openClassId=cls-1&openDate=${kst(cls1.start_time)}&center=c-near`);
        await page.waitForTimeout(1500);
        await shot(page, "03-deeplink-nopass", theme, sizeName);
        // 4) 수업 없는 센터 + 보유 무료 수강권
        await page.unroute("**/*.supabase.co/**"); await mockSupabase(page, { loggedIn: true, emptyCenterPass: true });
        await page.goto("/reservation?center=c-empty-center"); await page.waitForTimeout(1500);
        await shot(page, "04-reservation-empty-center", theme, sizeName);
        // 5) 검색 — 오늘 필터 0건
        await page.unroute("**/*.supabase.co/**"); await mockSupabase(page);
        await page.goto("/search"); await page.locator("#discovery-search").fill("요가");
        await expect(page.locator(".search-class-row").first()).toBeVisible();
        await page.getByRole("button", { name: "수업", exact: true }).click(); await page.getByRole("button", { name: "오늘 수업" }).click();
        await page.waitForTimeout(500); await shot(page, "05-search-today-empty", theme, sizeName);
        // 6) 결제
        await page.unroute("**/*.supabase.co/**"); await mockSupabase(page, { loggedIn: true, checkoutProduct: true });
        await page.goto("/checkout?center=c-near&product=prod-long"); await expect(page.locator(".checkout-order-name")).toBeVisible();
        await shot(page, "06-checkout-top", theme, sizeName);
        await page.locator(".checkout-pay-btn").scrollIntoViewIfNeeded(); await shot(page, "07-checkout-bottom", theme, sizeName);
        // 7) 마이 / 구매내역 — 무료 지급
        await page.unroute("**/*.supabase.co/**");
        await mockSupabase(page, { loggedIn: true, hasPass: true, emptyCenterPass: true, payments: [{ membership_id: "m-free", sale_type: "service", total_amount: 0 }, { membership_id: "m1", sale_type: "new", total_amount: 160000 }] });
        await page.goto("/mypage"); await expect(page.locator(".membership-card").first()).toBeVisible(); await page.waitForTimeout(400);
        await shot(page, "08-mypage-free", theme, sizeName);
        await page.goto("/purchases"); await expect(page.locator(".purchase-item").first()).toBeVisible();
        await shot(page, "09-purchases-free", theme, sizeName);
        // 8) 검색 결과 센터 카드(평점·지역)
        await page.unroute("**/*.supabase.co/**"); await mockSupabase(page);
        await page.goto("/search"); await page.locator("#discovery-search").fill("요가"); await expect(page.locator(".search-center-row").first()).toBeVisible();
        await page.getByRole("button", { name: "센터", exact: true }).click(); await page.waitForTimeout(600);
        await shot(page, "10-search-centers", theme, sizeName);
      });
    });
  }
}
