import { defineConfig, devices } from "@playwright/test";

// 네트워크 목(mock) 기반 UI 검증 — 실제 Supabase/결제/PG에 접속하지 않는다.
// dev 서버는 가짜 Supabase URL로 뜨고, 브라우저의 *.supabase.co 요청은 전부 tests/ui-mock/support/mockSupabase.ts가 가로채 고정 데이터로 응답한다.
// 실행: npx playwright test -c playwright.mock.config.ts
const PORT = Number(process.env.UI_MOCK_PORT ?? 3100);
export default defineConfig({
  testDir: "./tests/ui-mock",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  use: { baseURL: `http://localhost:${PORT}`, trace: "retain-on-failure" },
  projects: [
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 860 } } },
    { name: "mobile-chromium", use: { ...devices["Pixel 7"] } },
    { name: "mobile-webkit", use: { ...devices["iPhone 14"] } },
    { name: "tablet-chromium", use: { ...devices["iPad (gen 7)"], browserName: "chromium" } },
  ],
  webServer: {
    command: process.env.UI_MOCK_PROD === "1" ? `npx next start -p ${PORT}` : `npx next dev -p ${PORT}`,   // UI_MOCK_PROD=1: 먼저 같은 env로 next build 한 프로덕션 서버(개발용 오버레이 없는 스크린샷 증빙)
    url: `http://localhost:${PORT}`,
    reuseExistingServer: true,
    timeout: 180_000,
    env: { NEXT_PUBLIC_SUPABASE_URL: "https://abcdefghij0123456789.supabase.co", NEXT_PUBLIC_SUPABASE_ANON_KEY: "mock-anon-key", NEXT_PUBLIC_ALLOW_MOCK_PAYMENT: "false" },
  },
});
