/* Playwright globalSetup — 어떤 프로젝트·`--no-deps`·직접 spec 지정에서도 첫 테스트 전에 실행된다(`--list`에서는 실행되지 않음).
   기본 거부(default deny): 격리 DB가 확인되지 않으면, 읽기 전용으로 설계된 관리자 페이지네이션 러너(RUN_ADMIN_PAGINATION=1)를 제외한 모든 E2E 실행을 중단한다.
   UI가 일으키는 쓰기(예약·결제·설정 저장 등)와 admin fixture 쓰기를 DB 종류와 무관하게 막는 마지막 안전망이다.
   페이지네이션 러너도 Production/공유 DEV 거부 규칙 중 Production은 env.ts가, admin client·계정 생성은 fixtureWriteGate가 막는다. */
import { assertIsolatedTestDb, IsolatedTestDbGuardError } from "./fixtures/isolatedTestDbGuard";
import "./fixtures/installWriteGate";

export function e2eRunAllowed(env: Record<string, string | undefined>): { ok: true } | { ok: false; reason: string } {
  if (env.RUN_ADMIN_PAGINATION === "1") return { ok: true };
  try {
    assertIsolatedTestDb(env);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e instanceof IsolatedTestDbGuardError ? e.message : "격리 DB 확인 중 알 수 없는 오류" };
  }
}

export default async function globalSetup(): Promise<void> {
  const r = e2eRunAllowed(process.env);
  if (!r.ok) throw new Error(`BLOCKED: E2E 실행 거부 — ${r.reason}\n(읽기 전용 관리자 페이지네이션은 npm run test:e2e:admin-pagination 으로만 실행할 수 있습니다.)`);
}
