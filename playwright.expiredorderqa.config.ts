import { defineConfig, devices } from "@playwright/test";

// 만료 상품 주문 처리 E2E(회원 주문 생성 → 센터 관리자 처리) 격리 환경 QA 전용 설정 — 로컬/CI 일회용 격리 스택에서만 실행한다.
// 데스크톱 1440×900, 모바일 iPhone 13 프로필(390×844, 터치, 라이트 모드).
// 앱 서버: 수동 실행은 격리 env 로 미리 띄운다(EXPIREDORDER_BASE_URL, 기본 http://localhost:3021). CI 는 EXPIREDORDER_START_SERVER=1 로 이 설정이 :3021 에서 직접 띄운다.
//   · 포트 3021 은 기본 playwright.config.ts(:3000)·다른 QA 설정과 겹치지 않는다. CI 에서는 reuseExistingServer=false 라 :3021 이 이미 점유돼 있으면 즉시 실패한다(다른 서버를 재사용하지 않는다).
const PORT = 3021;
const baseURL = process.env.EXPIREDORDER_BASE_URL ?? `http://localhost:${PORT}`;

// 가드: 격리가 아닌 대상으로는 설정 로드 단계에서 중단한다(spec 도 같은 가드를 한 번 더 건다).
// ① Supabase URL 은 로컬(127.0.0.1/localhost)만, ② 실제 PG·알림 자격증명 환경변수가 하나라도 있으면 중단.
{
  let host = ""; try { host = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").hostname; } catch { /* */ }
  if (!["127.0.0.1", "localhost"].includes(host)) throw new Error("ISOLATED_GUARD: NEXT_PUBLIC_SUPABASE_URL 이 로컬 격리 스택이 아니에요 — 실행하지 않고 중단");
  const live = Object.keys(process.env).filter((k) => /(NICEPAY|TOSS|PORTONE|IAMPORT|ALIGO|SOLAPI|VAPID).*(KEY|SECRET|MID|TOKEN|PASSWORD)/i.test(k) && String(process.env[k] ?? "").trim() !== "");
  if (live.length) throw new Error(`ISOLATED_GUARD: 실제 결제·알림 자격증명 환경변수가 있어요(${live.join(", ")}) — 실행하지 않고 중단`);
}

export default defineConfig({
  testDir: "./tests/expired-order-qa", testMatch: /member-to-manager\.spec\.ts/, fullyParallel: false, workers: 1, retries: 0, timeout: 180_000, expect: { timeout: 15_000 },
  outputDir: process.env.EXPIREDORDER_OUT ? `${process.env.EXPIREDORDER_OUT}/artifacts` : "test-results-expiredorderqa",
  reporter: [["list"], ["json", { outputFile: process.env.EXPIREDORDER_OUT ? `${process.env.EXPIREDORDER_OUT}/results-e2e.json` : "test-results-expiredorderqa/results.json" }]],
  use: { baseURL, trace: "retain-on-failure", screenshot: "only-on-failure", colorScheme: "light" },
  webServer: process.env.EXPIREDORDER_START_SERVER === "1"
    ? { command: `npx next dev -p ${PORT}`, url: `http://localhost:${PORT}`, reuseExistingServer: !process.env.CI, timeout: 180_000, env: { NEXT_TELEMETRY_DISABLED: "1" } }
    : undefined,
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    { name: "mobile", use: { ...devices["iPhone 13"], browserName: "chromium", viewport: { width: 390, height: 844 } } },
  ],
});
