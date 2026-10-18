/* E2E 프로세스(메인·워커 모두)에서 DB 쓰기 경로 직전에 격리 DB 가드를 강제하는 훅 설치.
   tests/integration/setup.ts의 getFixtureAdminClient / switchToTestUser(signUp·INSERT)가 호출 직전에 이 훅을 부른다.
   env.ts(playwright.config가 가장 먼저 import)와 fixtures/testData.ts가 import해 어떤 스펙·setup·fixture 초기화도 이 훅 없이 admin client를 얻을 수 없다.
   훅은 process.env를 호출 시점에 읽는다(캐시 없음). 가드 실패 시 DB 접속 전에 예외. */
import { assertIsolatedTestDb, IsolatedTestDbGuardError } from "./isolatedTestDbGuard";

export const FIXTURE_WRITE_GATE = Symbol.for("mwhabit.fixtureWriteGate");

export function fixtureWriteGate(action: string): void {
  try {
    assertIsolatedTestDb(process.env);
  } catch (e) {
    if (e instanceof IsolatedTestDbGuardError) throw new IsolatedTestDbGuardError(`BLOCKED: '${action}' 실행 거부 — ${e.message}`);
    throw e;
  }
}

(globalThis as Record<symbol, unknown>)[FIXTURE_WRITE_GATE] = fixtureWriteGate;
