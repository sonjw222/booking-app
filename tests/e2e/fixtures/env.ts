// E2E(Playwright) 전용 환경변수 로더.
// tests/integration/loadEnv.ts와 동일한 규칙(.env.test.local 로컬 로드, CI는 Secrets 직접 주입)을
// 따르되, E2E가 실제로 로그인에 쓰는 두 계정(TEST_MANAGER_A/TEST_USER_A)만 필수로 검증한다.
import { config } from "dotenv";
import path from "node:path";

config({ path: path.resolve(process.cwd(), ".env.test.local") });

const REQUIRED = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "TEST_MANAGER_A_EMAIL",
  "TEST_MANAGER_A_PASSWORD",
  "TEST_USER_A_EMAIL",
  "TEST_USER_A_PASSWORD",
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
