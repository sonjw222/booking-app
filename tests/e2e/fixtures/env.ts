// E2E(Playwright) 전용 환경변수 로더.
// tests/integration/loadEnv.ts와 동일한 규칙(.env.test.local 로컬 로드, CI는 Secrets 직접 주입)을
// 따르되, E2E가 실제로 로그인에 쓰는 계정(TEST_MANAGER_A/TEST_USER_A/TEST_USER_B)만 필수로
// 검증한다. TEST_USER_B는 P0-4(일일예약한도가 계정별로 독립적인지)처럼 두 번째 회원 계정이
// 필요한 시나리오 전용 — TEST_MANAGER_B는 tests/integration 쪽에서만 쓰고 있어 여기 포함하지
// 않는다(필요해지면 그때 추가).
import { config } from "dotenv";
import path from "node:path";
import { assertIntegrationTargetIsNotProduction } from "../../integration/productionGuard";

config({ path: path.resolve(process.cwd(), ".env.test.local") });

// Production 차단(최우선, 2026-10-07): playwright.config.ts가 이 파일을 가장 먼저 import하므로 브라우저/webServer(npm run dev)가 시작되기 전에 실행된다.
// integration(tests/integration/loadEnv.ts)과 같은 순수 helper를 쓴다(정책 drift 방지 — 단위 테스트가 두 진입점 모두 이 함수를 호출하는지 확인).
assertIntegrationTargetIsNotProduction(process.env);
// 대상 URL이 없으면 webServer(Next dev)가 로컬 .env.local(Production을 가리킬 수 있음)을 읽어 버리므로, 대상을 확인할 수 없는 상태에서는 시작하지 않는다.
if (!process.env.NEXT_PUBLIC_SUPABASE_URL?.trim()) {
  throw new Error(
    "E2E 대상 Supabase URL(NEXT_PUBLIC_SUPABASE_URL)이 설정되지 않아 실행을 중단합니다 — 대상이 확인되지 않으면 앱 서버가 .env.local(Production일 수 있음)을 읽을 수 있습니다. " +
      ".env.test.local(개발/테스트 프로젝트) 또는 CI Secrets를 설정하세요."
  );
}

const REQUIRED = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "TEST_MANAGER_A_EMAIL",
  "TEST_MANAGER_A_PASSWORD",
  "TEST_USER_A_EMAIL",
  "TEST_USER_A_PASSWORD",
  "TEST_USER_B_EMAIL",
  "TEST_USER_B_PASSWORD",
];

export function requireE2eEnv(): void {
  const missing = REQUIRED.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(
      `E2E 테스트에 필요한 환경변수가 없습니다: ${missing.join(", ")}\n` +
        `.env.test.local.example을 복사해 .env.test.local을 만들고 값을 채워주세요 ` +
        `(로컬 실행). GitHub Actions에서는 동일한 이름으로 Repository Secrets에 등록하세요.`
    );
  }
}
