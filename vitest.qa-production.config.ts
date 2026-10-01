import { defineConfig } from "vitest/config";

// Production 전용 QA runner 설정. test / test:integration 어느 쪽도 tests/qa를 포함하지 않으므로
// 이 설정을 명시적으로 지정한 별도 명령(npm run qa:production:*)에서만 실행된다.
// 안전장치(QA_TARGET_PROJECT_REF, QA_PRODUCTION_ACK=1)가 없으면 setupFile에서 즉시 중단한다.
export default defineConfig({
  test: {
    include: ["tests/qa/**/*.qa.test.ts"],
    environment: "node",
    setupFiles: ["tests/qa/qaEnv.ts"],
    testTimeout: 60000,
    hookTimeout: 60000,
    fileParallelism: false,
  },
});
