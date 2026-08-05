import { defineConfig, devices } from "@playwright/test";
import "./tests/e2e/fixtures/env"; // .env.test.local 로드 + 필수 env 존재만 확인(로그인용 계정)

// E2E(Playwright) 설정.
// - 실제 개발용 Supabase에 실제 테스트 계정으로 로그인해 브라우저를 조작하므로, 통합 테스트와
//   같은 이유로 완전 병렬 실행을 끄고 순차 실행한다(같은 테스트 계정 세션을 여러 워커가
//   동시에 로그인/로그아웃하면 서로 꼬일 수 있음 — tests/integration/setup.ts의 authMutex와
//   같은 문제).
// - Chromium 하나만 사용한다(Firefox/WebKit/모바일은 아직 추가하지 않음).
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [
    ["html", { outputFolder: "playwright-report", open: "never" }],
    ["list"],
  ],
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      // 로그인만 수행해 storageState를 파일로 저장하는 전용 프로젝트. 다른 모든 프로젝트가
      // 이 프로젝트에 의존해, 매 테스트마다 로그인 폼을 다시 거치지 않고 저장된 로그인
      // 상태를 재사용한다.
      name: "setup",
      testMatch: /auth\.setup\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      dependencies: ["setup"],
      testIgnore: /auth\.setup\.ts/,
    },
  ],
  webServer: {
    // 프로덕션 빌드 대신 dev 서버로 띄운다 — 이 앱의 다른 CI 잡(Vercel)이 이미 프로덕션
    // 빌드를 검증하므로, E2E는 기동 속도가 더 빠른 dev 서버로 충분하다.
    command: "npm run dev",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
