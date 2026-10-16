/* 파괴적 E2E(수업·수강권·결제·설정을 admin client로 만들고 지우는 테스트) 전용 "격리 DB 확인" 가드. 순수 함수 — 네트워크/DB 접속 없음.
   Production 차단(tests/integration/productionGuard.ts)만으로는 "공유 DEV"를 막지 못한다: 공유 DEV는 Production이 아니므로 통과해 버린다.
   그래서 차단 목록(denylist)이 아니라 **명시적 허용(allowlist)** 방식이다:
     1) ISOLATED_TEST_DB_PROJECT_REF — 실행하는 사람이 "이 테스트 전용 격리 프로젝트의 ref"를 직접 선언해야 한다(기본값 없음).
     2) ISOLATED_TEST_DB_ACK=I_CONFIRM_DISPOSABLE_TEST_DB — 그 DB가 언제든 지워져도 되는 격리 DB임을 확인하는 고정 문구.
     3) NEXT_PUBLIC_SUPABASE_URL의 호스트가 선언한 ref와 정확히 일치(부분 일치·경로·userinfo 우회 불가), SUPABASE_SERVICE_ROLE_KEY/ANON 키의
        ref claim이 있으면 같은 ref여야 한다.
     4) 선언한 ref가 알려진 Production ref이거나 SHARED_DEV_PROJECT_REFS(쉼표 목록, 선택)에 있으면 거부.
   값(URL/키)은 메시지에 넣지 않는다. 격리 프로젝트가 아직 없으면 이 가드는 항상 실패하고 파괴적 E2E는 실행되지 않는다(= BLOCKED). */
import { KNOWN_PRODUCTION_PROJECT_REFS, projectRefFromSupabaseKey } from "../../integration/productionGuard";

/* 어떤 선언·ACK·환경변수로도 허용되지 않는 프로젝트(코드에 고정). 값은 프로젝트 식별자일 뿐 비밀이 아니다.
   - Production: KNOWN_PRODUCTION_PROJECT_REFS (integration 가드와 같은 목록)
   - 공유 DEV: 여러 사람이 쓰는 실제 테스트 계정·센터·예약이 있는 프로젝트 */
export const SHARED_DEV_PROJECT_REF = "jdglfvwdnkjnraqdxuuj";
export const ALWAYS_DENIED_PROJECT_REFS: readonly string[] = [...KNOWN_PRODUCTION_PROJECT_REFS, SHARED_DEV_PROJECT_REF];

export type GuardEnv = Record<string, string | undefined>;
export const ISOLATED_DB_ACK_PHRASE = "I_CONFIRM_DISPOSABLE_TEST_DB";

export class IsolatedTestDbGuardError extends Error {
  constructor(message: string) { super(message); this.name = "IsolatedTestDbGuardError"; }
}

function supabaseRefFromUrl(raw: string | undefined): string | null {
  if (!raw?.trim()) return null;
  try {
    const u = new URL(raw.trim());
    if (u.username || u.password || (u.pathname && u.pathname !== "/") || u.search || u.hash) return null; // 이상한 URL은 거부(fail closed)
    const host = u.hostname.toLowerCase().replace(/\.+$/, "");
    const m = host.match(/^([a-z0-9]{20})\.supabase\.co$/);
    return m ? m[1] : null;
  } catch { return null; }
}

export function assertIsolatedTestDb(env: GuardEnv): void {
  const problems: string[] = [];
  const declared = env.ISOLATED_TEST_DB_PROJECT_REF?.trim().toLowerCase();
  // 항상 거부(선언·ACK와 무관): 선언 ref, URL, 키 어디에서든 Production/공유 DEV ref가 보이면 거부한다. URL은 해석 실패해도 부분 문자열로 한 번 더 본다.
  const rawUrls = [env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_URL].map((u) => (u ?? "").toLowerCase());
  const keyRefs = ["SUPABASE_SERVICE_ROLE_KEY", "NEXT_PUBLIC_SUPABASE_ANON_KEY"].map((n) => projectRefFromSupabaseKey(env[n]));
  for (const denied of ALWAYS_DENIED_PROJECT_REFS) {
    if (declared === denied || rawUrls.some((u) => u.includes(denied)) || keyRefs.includes(denied)) {
      problems.push("대상이 Production 또는 공유 DEV 프로젝트임(어떤 선언·확인 문구로도 허용되지 않음)");
      break;
    }
  }
  if (!declared) problems.push("ISOLATED_TEST_DB_PROJECT_REF 미선언 — 격리 테스트 DB가 지정되지 않음");
  if (env.ISOLATED_TEST_DB_ACK !== ISOLATED_DB_ACK_PHRASE) problems.push("ISOLATED_TEST_DB_ACK 확인 문구 없음");
  if (declared) {
    if (KNOWN_PRODUCTION_PROJECT_REFS.includes(declared)) problems.push("선언된 ref가 Production 프로젝트임");
    const shared = (env.SHARED_DEV_PROJECT_REFS ?? "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
    if (shared.includes(declared)) problems.push("선언된 ref가 공유 DEV 프로젝트 목록(SHARED_DEV_PROJECT_REFS)에 있음");
    const urlRef = supabaseRefFromUrl(env.NEXT_PUBLIC_SUPABASE_URL);
    if (urlRef !== declared) problems.push("NEXT_PUBLIC_SUPABASE_URL이 선언된 격리 프로젝트와 일치하지 않음(또는 해석 불가)");
    for (const name of ["SUPABASE_SERVICE_ROLE_KEY", "NEXT_PUBLIC_SUPABASE_ANON_KEY"]) {
      const keyRef = projectRefFromSupabaseKey(env[name]);
      if (keyRef && keyRef !== declared) problems.push(`${name}의 project ref가 선언된 격리 프로젝트와 다름`);
    }
  }
  if (problems.length) {
    throw new IsolatedTestDbGuardError(
      `파괴적 E2E 차단 — 격리 테스트 DB가 확인되지 않았습니다: ${problems.join("; ")}.\n` +
        "이 테스트는 수업·수강권·결제를 만들고 지웁니다. 공유 DEV/Production에서는 실행하지 않습니다. 전용 격리 Supabase 프로젝트를 준비한 뒤 ref와 확인 문구를 선언하세요."
    );
  }
}
