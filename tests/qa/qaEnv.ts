/*
  Production QA 전용 env 로더(vitest setupFile). 일반 test/test:integration에서는 로드되지 않는다.
  - 기존 테스트 env 이름을 그대로 재사용한다: .env.test.local(또는 QA_ENV_FILE이 가리키는 파일)에서 읽는다.
  - 안전장치(tests/qa/guard.ts)를 통과하지 못하면 어떤 테스트도 실행하기 전에 즉시 중단한다.
  - 값(비밀번호/키)은 출력하지 않는다. 누락된 env는 "이름만" 알려준다.
*/
import { config } from "dotenv";
import path from "node:path";
import { assertProductionQaAllowed, missingQaEnvNames } from "./guard";

config({ path: process.env.QA_ENV_FILE ? path.resolve(process.env.QA_ENV_FILE) : path.resolve(process.cwd(), ".env.test.local") });

const missing = missingQaEnvNames(process.env);
if (missing.length > 0) {
  throw new Error(
    `Production QA에 필요한 환경변수가 없습니다(이름만 표시): ${missing.join(", ")}\n` +
      `기존 .env.test.local(또는 QA_ENV_FILE로 지정한 파일)에 설정하세요. 템플릿: .env.test.local.example, QA 전용 변수는 QA_TARGET_PROJECT_REF / QA_PRODUCTION_ACK.`
  );
}
assertProductionQaAllowed(process.env);

// tests/integration/setup.ts는 import 시점에 공유 통합 센터/상품 env를 요구한다. QA runner는 그 공유 센터를 절대 쓰지 않고
// (전용 [QA] 센터만 사용) 기존 get-or-create 로그인 헬퍼만 재사용하므로, 없을 때만 의미 없는 자리표시 값으로 import 요건을 채운다.
process.env.TEST_CENTER_ID ||= "00000000-0000-4000-8000-000000000000";
process.env.TEST_PRODUCT_ID ||= "00000000-0000-4000-8000-000000000001";
