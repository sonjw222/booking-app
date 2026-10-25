import { configDefaults, defineConfig } from "vitest/config";

// 통합 테스트(tests/integration) 전용 설정.
// 실제 개발용 Supabase 프로젝트에 실제 RPC를 호출하므로:
// - .env.test.local(로컬) 또는 CI Secrets(GitHub Actions)에서 환경변수를 읽음
// - 같은 테스트 계정(A/B)을 여러 파일이 로그인/로그아웃하며 순서대로 공유하므로
//   파일을 병렬 실행하면 세션이 서로 덮어써 꼬일 수 있어 fileParallelism을 끔
export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    // 전역 기본 요금제(subscription_plans.is_default)를 바꾸고 공유 계정을 임시 승격하는 파일은 일반 CI에서 제외 —
    // 수동 스위트(vitest.integration.privileged.config.ts)에서만 실행한다. 파일 내용은 그대로 보존된다.
    exclude: [...configDefaults.exclude, "tests/integration/subscription-plan-limits.test.ts"],
    environment: "node",
    globalSetup: ["tests/integration/globalSetup.ts"],
    setupFiles: ["tests/integration/loadEnv.ts"],
    testTimeout: 20000,
    hookTimeout: 20000,
    fileParallelism: false,
  },
});
