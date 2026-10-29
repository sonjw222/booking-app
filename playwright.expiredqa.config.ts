import { defineConfig, devices } from "@playwright/test";

// 만료 상품 자동 노출 종료 QA(2026-10-31) 전용 설정 — 로컬 격리 스택에서만 실행(수동). 앱 서버는 격리 env 로 미리 띄운다(EXPIREDQA_BASE_URL, 기본 http://localhost:3020).
export default defineConfig({
  testDir: "./tests/expired-product-qa", fullyParallel: false, workers: 1, retries: 0, timeout: 90_000, expect: { timeout: 12_000 },
  outputDir: process.env.EXPIREDQA_OUT ? `${process.env.EXPIREDQA_OUT}/artifacts` : "test-results-expiredqa",
  reporter: [["list"], ["json", { outputFile: process.env.EXPIREDQA_OUT ? `${process.env.EXPIREDQA_OUT}/results.json` : "test-results-expiredqa/results.json" }]],
  use: { baseURL: process.env.EXPIREDQA_BASE_URL ?? "http://localhost:3020", trace: "retain-on-failure", screenshot: "only-on-failure", viewport: { width: 1280, height: 900 } },
  projects: [{ name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 } } }, { name: "mobile", use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 }, isMobile: true } }],
});
