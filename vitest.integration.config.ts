import { defineConfig } from "vitest/config";

// 통합 테스트(tests/integration) 전용 설정.
// 실제 개발용 Supabase 프로젝트에 실제 RPC를 호출하므로:
// - .env.test.local(로컬) 또는 CI Secrets(GitHub Actions)에서 환경변수를 읽음
// - 같은 테스트 계정(A/B)을 여러 파일이 로그인/로그아웃하며 순서대로 공유하므로
//   파일을 병렬 실행하면 세션이 서로 덮어써 꼬일 수 있어 fileParallelism을 끔
export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    environment: "node",
    setupFiles: ["tests/integration/loadEnv.ts"],
    testTimeout: 20000,
    hookTimeout: 20000,
    fileParallelism: false,
  },
});
