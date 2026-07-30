import { defineConfig } from "vitest/config";

// 단위 테스트(tests/unit) 전용 설정.
// mockPaymentApi를 vi.mock()으로 대체하므로 실제 Supabase 접속이 전혀 필요 없다.
// lib/supabaseClient.ts가 모듈 로드 시 process.env.NEXT_PUBLIC_SUPABASE_URL을 읽어
// supabase-js의 createClient()에 넘기는데, 값이 없으면 그 시점에 에러가 나므로
// 실제로 쓰이지 않을 더미 값만 넣어 그 에러를 막는다(네트워크 호출은 발생하지 않음).
export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts"],
    environment: "node",
    env: {
      NEXT_PUBLIC_SUPABASE_URL: "https://unit-test-placeholder.supabase.co",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "unit-test-placeholder-anon-key",
    },
  },
});
