import { defineConfig, devices } from "@playwright/test";
import { execFileSync } from "node:child_process";

// 격리 QA(로컬 Docker PostgreSQL + PostgREST) 실데이터 브라우저 검증. 먼저 `tests/ui-real/run.sh up`, 끝나면 `tests/ui-real/run.sh down`.
// 스크린샷은 프로덕션 빌드로: `NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:3201 NEXT_PUBLIC_SUPABASE_ANON_KEY=$(tests/ui-real/run.sh token) npx next build` 후 UI_REAL_PROD=1.
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
  webServer: { command: process.env.UI_REAL_PROD === "1" ? `npx next start -p ${PORT}` : `npx next dev -p ${PORT}`,   // UI_REAL_PROD=1: 미리 빌드한 프로덕션 번들(개발용 오버레이 없음)로 실행(스크린샷용)
    url: `http://localhost:${PORT}`, reuseExistingServer: true, timeout: 180_000,
    env: { NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:3201", NEXT_PUBLIC_SUPABASE_ANON_KEY: ANON } },
});
