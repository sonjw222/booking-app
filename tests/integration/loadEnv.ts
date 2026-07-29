// 로컬 실행 시 .env.test.local을 process.env로 로드한다.
// CI(GitHub Actions)에서는 이 파일이 없어도 되고, dotenv가 조용히 무시한다 —
// Secrets가 이미 process.env에 직접 주입되어 있기 때문.
import { config } from "dotenv";
import path from "node:path";

config({ path: path.resolve(process.cwd(), ".env.test.local") });

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

// 운영 DB 오발동 방지 가드.
// ⚠ 현재 이 프로젝트는 Supabase 프로젝트가 하나뿐이라(별도 production 프로젝트가 아직 없음),
//   이 검사는 지금 당장은 아무 효과가 없다(PRODUCTION_SUPABASE_URL이 설정돼 있지 않으면 통과).
//   나중에 실제 운영 Supabase 프로젝트가 생기고 그 URL을 PRODUCTION_SUPABASE_URL로 등록해두면,
//   그 순간부터 이 검사가 자동으로 활성화되어 test:integration이 그 프로젝트를 가리킬 때
//   실행 자체를 막아준다 — 테스트 코드를 다시 손볼 필요가 없다.
if (
  process.env.PRODUCTION_SUPABASE_URL &&
  process.env.NEXT_PUBLIC_SUPABASE_URL === process.env.PRODUCTION_SUPABASE_URL
) {
  throw new Error(
    "test:integration이 PRODUCTION_SUPABASE_URL과 동일한 프로젝트(NEXT_PUBLIC_SUPABASE_URL)를 " +
      "가리키고 있습니다. 운영 DB에는 통합 테스트를 실행할 수 없습니다 — 개발용 Supabase 프로젝트로 바꿔주세요."
  );
}
