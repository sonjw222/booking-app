import { defineConfig, devices } from "@playwright/test";
// NICEPAY 결제창(v3) 격리 브라우저 QA — 로컬 격리 스택 + 모의 SDK + 모의 승인 서버(fetch 가로채기) 전용. 실제 NICEPAY 호출 0건. 수동 실행(scripts/isolated/nicepayQa/run.sh), 기본 CI 제외.
export default defineConfig({
  testDir: "./tests/nicepay-qa", testMatch: /.*\.spec\.ts$/, fullyParallel: false, workers: 1, retries: 0, timeout: 90_000, expect: { timeout: 12_000 },
  outputDir: process.env.NPQA_OUT ? `${process.env.NPQA_OUT}/artifacts` : "test-results-nicepayqa",
  reporter: [["list"], ["json", { outputFile: process.env.NPQA_OUT ? `${process.env.NPQA_OUT}/results.json` : "test-results-nicepayqa/results.json" }]],
  use: { baseURL: "http://localhost:3100", trace: "retain-on-failure", screenshot: "only-on-failure", viewport: { width: 1280, height: 900 } },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 } } }],
});
