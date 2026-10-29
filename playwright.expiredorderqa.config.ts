import { defineConfig, devices } from "@playwright/test";

// 만료 상품 주문 처리 E2E(회원 주문 생성 → 센터 관리자 처리) 격리 환경 QA 전용 설정 — 로컬 격리 스택에서만 수동 실행.
// 데스크톱 1440×900, 모바일 iPhone 13 프로필(390×844, 터치, 라이트 모드). 앱 서버는 격리 env 로 미리 띄운다(EXPIREDORDER_BASE_URL, 기본 http://localhost:3021).
export default defineConfig({
  testDir: "./tests/expired-order-qa", testMatch: /member-to-manager\.spec\.ts/, fullyParallel: false, workers: 1, retries: 0, timeout: 180_000, expect: { timeout: 15_000 },
  outputDir: process.env.EXPIREDORDER_OUT ? `${process.env.EXPIREDORDER_OUT}/artifacts` : "test-results-expiredorderqa",
  reporter: [["list"], ["json", { outputFile: process.env.EXPIREDORDER_OUT ? `${process.env.EXPIREDORDER_OUT}/results-e2e.json` : "test-results-expiredorderqa/results.json" }]],
  use: { baseURL: process.env.EXPIREDORDER_BASE_URL ?? "http://localhost:3021", trace: "retain-on-failure", screenshot: "only-on-failure", colorScheme: "light" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    { name: "mobile", use: { ...devices["iPhone 13"], browserName: "chromium", viewport: { width: 390, height: 844 } } },
  ],
});
