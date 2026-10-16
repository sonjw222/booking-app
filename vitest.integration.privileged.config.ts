import { defineConfig } from "vitest/config";

// 수동 전용(npm run test:integration:privileged) — 일반 CI/ test:integration에서는 실행되지 않는다.
// 공유 DEV 계정의 is_platform_admin 임시 승격과 전역 기본 요금제 변경이 필요한 통합 테스트만 모은다.
// 독립된(비공유) DEV 프로젝트·계정에서, 사람이 ALLOW_PRIVILEGED_DEV_TESTS=1 + ACK를 지정해 실행한다.
// privilegedPreflight는 읽기 전용이며 오염이 있으면 BLOCKED로 중단한다(자동 복구 없음).
export default defineConfig({
  test: {
    include: [
      "tests/integration/subscription-plan-limits.test.ts",
      "tests/integration/sec009-batch-a2-rls.test.ts",
      "tests/integration/auto-book-membership-security.test.ts",
    ],
    environment: "node",
    globalSetup: ["tests/integration/privilegedPreflight.ts", "tests/integration/globalSetup.ts"],
    setupFiles: ["tests/integration/loadEnv.ts"],
    testTimeout: 20000,
    hookTimeout: 20000,
    fileParallelism: false,
  },
});
