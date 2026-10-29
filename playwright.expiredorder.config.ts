import { defineConfig, devices } from "@playwright/test";

// 만료 상품 기존 주문 처리 UI QA(2026-10-31) 전용 설정 — 로컬 격리 스택에서만 실행(수동). 앱 서버는 격리 env 로 미리 띄운다(EXPIREDORDER_BASE_URL, 기본 http://localhost:3021).
export default defineConfig({
  testDir: "./tests/expired-order-qa", fullyParallel: false, workers: 1, retries: 0, timeout: 120_000, expect: { timeout: 15_000 },
  outputDir: process.env.EXPIREDORDER_OUT ? `${process.env.EXPIREDORDER_OUT}/artifacts` : "test-results-expiredorder",
  reporter: [["list"], ["json", { outputFile: process.env.EXPIREDORDER_OUT ? `${process.env.EXPIREDORDER_OUT}/results.json` : "test-results-expiredorder/results.json" }]],
  use: { baseURL: process.env.EXPIREDORDER_BASE_URL ?? "http://localhost:3021", trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [{ name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 } } }, { name: "mobile", use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 }, isMobile: true } }],
});
