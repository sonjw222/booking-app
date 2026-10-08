// 로컬 실행 시 .env.test.local을 process.env로 로드한다.
// CI(GitHub Actions)에서는 이 파일이 없어도 되고, dotenv가 조용히 무시한다 —
// Secrets가 이미 process.env에 직접 주입되어 있기 때문.
import { config } from "dotenv";
import path from "node:path";
import { assertIntegrationTargetIsNotProduction } from "./productionGuard";

config({ path: path.resolve(process.cwd(), ".env.test.local") });

// Production 차단(최우선): dotenv가 값을 채운 직후, 필수 env 검증/Supabase client 생성/DB 접근보다 먼저 실행한다.
// 알려진 Production project ref(bxntqggkfwnhcczsbqtj)를 코드에 고정해 환경변수 설정 여부와 무관하게 막는다(tests/integration/productionGuard.ts).
// vitest.integration.config.ts의 globalSetup/setupFiles가 모두 이 파일을 먼저 로드하므로 test:integration, test:all(→ test:integration), qa:business:*가 전부 여기서 멈춘다.
assertIntegrationTargetIsNotProduction(process.env);

// lib/supabaseClient.ts는 이 값이 없으면 "supabaseUrl is required." 같은 알아보기 힘든
// 에러를 던지므로, 여기서 먼저 검증해 명확한 안내를 준다.
const REQUIRED = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "TEST_USER_A_EMAIL",
  "TEST_USER_A_PASSWORD",
  "TEST_USER_B_EMAIL",
  "TEST_USER_B_PASSWORD",
  "TEST_CENTER_ID",
  "TEST_PRODUCT_ID",
];
const missing = REQUIRED.filter((name) => !process.env[name]);
if (missing.length > 0) {
  throw new Error(
    `통합 테스트에 필요한 환경변수가 없습니다: ${missing.join(", ")}\n` +
      `.env.test.local.example을 복사해 .env.test.local을 만들고 값을 채워주세요 ` +
      `(로컬 실행). GitHub Actions에서는 동일한 이름으로 Repository Secrets에 등록하세요.`
  );
}

// (추가 방어선 PRODUCTION_SUPABASE_URL 비교는 위 assertIntegrationTargetIsNotProduction에 정규화 비교로 통합됐다.)
