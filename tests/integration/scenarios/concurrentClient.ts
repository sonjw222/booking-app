/*
  Automated Business Scenario E2E Batch(2026-09-18) — Phase 2 전용 헬퍼.

  ⚠ 왜 setup.ts의 supabase 싱글턴을 쓰지 않는가: setup.ts의 authMutex/withAuthLock은
  "동시에 두 계정 세션을 들고 있을 수 없다"는 싱글턴의 한계를 감추기 위해 auth 전환을
  일부러 직렬화한 것이다(파일 상단 주석 참고) — 즉 그 설계 자체가 "진짜 동시성(두 사용자가
  같은 순간에 각자의 세션으로 요청을 보냄)"을 구조적으로 배제한다. Phase 2의 race
  시나리오(더블클릭/동시예약/동시취소)는 정확히 그 "배제된 상황"을 재현해야 하므로, 이
  파일은 fixture 준비(계정 get-or-create, 센터/수업/수강권 생성)는 여전히 기존
  tests/integration/setup.ts + actors.ts를 그대로 쓰되, race를 일으키는 RPC 호출 그 자체만
  독립된 client 인스턴스(각자 자기 세션)로 Promise.all로 동시에 쏜다 — 새 테스트 인프라를
  중복 생성하는 게 아니라, 기존 인프라가 구조적으로 다룰 수 없는 한 가지(동시 세션)만
  최소한으로 보충하는 것이다. 실제 서비스에서도 "동시 요청"은 서로 다른 기기/탭의 별도
  세션에서 오므로, 오히려 이 방식이 실제 상황에 더 가깝다.
*/
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { requireEnv } from "../setup";

export async function loginConcurrentClient(emailEnvName: string, passwordEnvName: string): Promise<SupabaseClient> {
  const url = requireEnv("NEXT_PUBLIC_SUPABASE_URL");
  const anonKey = requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  const email = requireEnv(emailEnvName);
  const password = requireEnv(passwordEnvName);
  // persistSession:false — Node 프로세스에 세션을 남기지 않는다(브라우저 localStorage가
  // 없는 환경이라 어차피 기본값도 메모리뿐이지만, 명시적으로 의도를 남김).
  const client = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`concurrent client 로그인 실패(${emailEnvName}): ${error.message}`);
  return client;
}
