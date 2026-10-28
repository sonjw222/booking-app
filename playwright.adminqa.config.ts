import { defineConfig, devices } from "@playwright/test";

// 관리자 전 액션·역할별 실브라우저 QA(이슈 #239) 전용 설정. 로컬 격리 스택(isolated-supabase)에서만 실행한다.
// - 앱 서버(npm run dev)는 미리 격리 스택 env 로 띄워 둔다(reuseExistingServer). 공유 DEV·운영 URL 이면 헬퍼의 가드가 즉시 중단한다.
// - 기본 CI(test.yml)에는 포함되지 않는다(수동 실행). 사용: ISO_ENV_FILE=… scripts/isolated/adminQa/run.sh
export default defineConfig({
  testDir: "./tests/admin-qa",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 12_000 },
  outputDir: process.env.ADMINQA_OUT ? `${process.env.ADMINQA_OUT}/artifacts` : "test-results-adminqa",
  reporter: [["list"], ["json", { outputFile: process.env.ADMINQA_OUT ? `${process.env.ADMINQA_OUT}/results.json` : "test-results-adminqa/results.json" }]],
  use: { baseURL: "http://localhost:3000", trace: "retain-on-failure", screenshot: "only-on-failure", video: "off", viewport: { width: 1280, height: 900 } },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 } } }],
});
