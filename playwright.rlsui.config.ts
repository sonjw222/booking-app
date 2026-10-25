import { defineConfig, devices } from "@playwright/test";
import { createHmac } from "node:crypto";
// 격리 PostgREST(tests/rls-real/run.sh up + ui-seed) + 프록시(PROXY_PORT=3211 POSTGREST_PORT=3203 node tests/ui-real/proxy.mjs)에 앱을 붙여 관리자/회원 화면을 실제 데이터로 확인한다. 운영/공유 DEV 접속 없음.
const b = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const h = b({ alg: "HS256", typ: "JWT" }), p = b({ role: "anon", iss: "qa", exp: 4102444800 });
const ANON = `${h}.${p}.${createHmac("sha256", "qa-secret-qa-secret-qa-secret-1234567890").update(`${h}.${p}`).digest("base64url")}`;
const PORT = Number(process.env.UI_RLS_PORT ?? 3310);
export default defineConfig({
  testDir: "./tests/rls-real", testMatch: /.*\.ui\.spec\.ts/, workers: 1, timeout: 90_000, expect: { timeout: 15_000 }, reporter: [["list"]],
  use: { baseURL: `http://localhost:${PORT}` },
  projects: [{ name: "desktop-chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } }, { name: "mobile-chromium", use: { ...devices["Pixel 7"] } }],
  webServer: { command: process.env.UI_RLS_PROD === "1" ? `npx next start -p ${PORT}` : `npx next dev -p ${PORT}`, url: `http://localhost:${PORT}`, reuseExistingServer: true, timeout: 180_000,
    env: { NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:3211", NEXT_PUBLIC_SUPABASE_ANON_KEY: ANON, ...(process.env.NEXT_PUBLIC_ADMIN_CENTER_PAGINATION ? { NEXT_PUBLIC_ADMIN_CENTER_PAGINATION: process.env.NEXT_PUBLIC_ADMIN_CENTER_PAGINATION } : {}) } },
});
