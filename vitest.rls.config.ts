import { defineConfig } from "vitest/config";
// 격리 PostgREST(tests/rls-real/run.sh up)에 일반 회원/관리자 JWT로 붙는 실제 권한 검증. 기본 `npm test`에는 포함되지 않는다.
export default defineConfig({ test: { include: ["tests/rls-real/**/*.rls.test.ts"], environment: "node", testTimeout: 30_000, hookTimeout: 30_000, fileParallelism: false } });
