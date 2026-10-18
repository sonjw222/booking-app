import { defineConfig, devices } from "@playwright/test";
import { execFileSync } from "node:child_process";

// 격리 QA(로컬 Docker PostgreSQL + PostgREST) 실데이터 브라우저 검증. 먼저 `tests/ui-real/run.sh up`, 끝나면 `tests/ui-real/run.sh down`.
// 공유 DEV/운영에는 접속하지 않는다(앱의 Supabase URL 이 http://127.0.0.1:3201 프록시). Mock(tests/ui-mock)과 달리 SQL·PostgREST 질의가 실제로 실행된다.
const PORT = Number(process.env.UI_REAL_PORT ?? 3300);
const ANON = execFileSync("bash", ["tests/ui-real/run.sh", "token"]).toString().trim();
export default defineConfig({
  testDir: "./tests/ui-real", testMatch: /.*\.spec\.ts/, workers: 1, timeout: 90_000, expect: { timeout: 15_000 }, reporter: [["list"]],
  use: { baseURL: `http://localhost:${PORT}`, geolocation: { latitude: 37.5665, longitude: 126.978 }, permissions: ["geolocation"] },
  projects: [
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    { name: "mobile-chromium", use: { ...devices["Pixel 7"] } },
    { name: "mobile-webkit", use: { ...devices["iPhone 14"] } },
    { name: "tablet-chromium", use: { ...devices["iPad (gen 7)"], browserName: "chromium" } },
  ],
  webServer: { command: `npx next dev -p ${PORT}`, url: `http://localhost:${PORT}`, reuseExistingServer: true, timeout: 180_000,
    env: { NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:3201", NEXT_PUBLIC_SUPABASE_ANON_KEY: ANON } },
});
