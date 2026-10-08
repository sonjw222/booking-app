/*
  통합 테스트 Production 차단 가드(순수 함수 — 네트워크/Supabase 접근 없음, 단위 테스트 대상).
  배경: .env.test.local이 실수로 Production Supabase를 가리킨 채 test:integration이 실행돼 Production DB에 테스트 데이터가 생긴 사고(2026-10).
  기존 가드(PRODUCTION_SUPABASE_URL === NEXT_PUBLIC_SUPABASE_URL)는 그 환경변수가 따로 설정돼 있어야만 작동했다.
  이 가드는 알려진 Production project ref를 코드에 고정해 두고, 환경변수가 없어도 항상 차단한다.
  - URL은 hostname을 파싱하고 원문 문자열도 함께 보아, project ref가 어디에든 들어 있으면 차단한다(trailing slash/대소문자/포트/userinfo/경로/trailing dot/깨진 URL 우회 불가, fail closed).
  - anon/service-role 키(JWT)의 `ref` claim도 확인한다(URL이 프록시/커스텀 도메인이어도 Production 키면 차단). 서명 검증은 하지 않고 값은 출력하지 않는다.
  tests/qa(의도적인 Production QA runner)는 이 모듈을 쓰지 않는다 — 별도 가드(tests/qa/guard.ts: QA_TARGET_PROJECT_REF + QA_PRODUCTION_ACK=1)를 쓴다.
*/
import { PRODUCTION_PROJECT_REF } from "../qa/guard";

export const KNOWN_PRODUCTION_PROJECT_REFS: readonly string[] = [PRODUCTION_PROJECT_REF];

export class IntegrationProductionGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntegrationProductionGuardError";
  }
}

// URL 문자열(스킴 없음/공백/대소문자 포함)을 정규화된 hostname으로. 파싱 불가면 null.
function hostnameOf(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  for (const candidate of [s, `https://${s}`]) {
    try {
      const h = new URL(candidate).hostname.toLowerCase().replace(/\.+$/, "");
      if (h) return h;
    } catch { /* 다음 후보 */ }
  }
  return null;
}

// 값이 알려진 Production 프로젝트를 가리키는 URL이면 그 ref를, 아니면 null.
export function productionRefInUrl(raw: string | undefined | null): string | null {
  if (!raw || !raw.trim()) return null;
  // 파싱 결과(hostname)와 원문 전체 모두에서 찾는다 — 파싱이 이상하게 되거나(예: 깨진 URL) 경로/userinfo에 숨겨도 fail closed.
  const haystack = `${hostnameOf(raw) ?? ""} ${raw}`.toLowerCase();
  return KNOWN_PRODUCTION_PROJECT_REFS.find((ref) => haystack.includes(ref)) ?? null;
}

// Supabase anon/service_role 키(JWT)의 ref claim. 서명은 검증하지 않는다(가드 목적상 "어느 프로젝트 키인가"만 본다).
export function projectRefFromSupabaseKey(key: string | undefined | null): string | null {
  if (!key) return null;
  const parts = key.trim().split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    return typeof payload?.ref === "string" ? payload.ref.toLowerCase() : null;
  } catch {
    return null;
  }
}

export type GuardEnv = Record<string, string | undefined>;

// Production를 가리키면 throw. 키 값/URL 원문은 메시지에 넣지 않는다(어느 변수 "이름"과 project ref만).
export function assertIntegrationTargetIsNotProduction(env: GuardEnv): void {
  const hits: string[] = [];
  for (const name of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_URL"]) {
    if (productionRefInUrl(env[name])) hits.push(name);
  }
  for (const name of ["NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SERVICE_KEY"]) {
    const ref = projectRefFromSupabaseKey(env[name]);
    if (ref && KNOWN_PRODUCTION_PROJECT_REFS.includes(ref)) hits.push(`${name}(키의 project ref)`);
  }
  // 기존 방어선: 운영 URL을 PRODUCTION_SUPABASE_URL로 따로 등록한 경우(정규화 비교 — trailing slash 등 무시)
  const prod = env.PRODUCTION_SUPABASE_URL, target = env.NEXT_PUBLIC_SUPABASE_URL;
  if (prod && target) {
    const a = hostnameOf(prod), b = hostnameOf(target);
    if (a && b && a === b) hits.push("NEXT_PUBLIC_SUPABASE_URL(=PRODUCTION_SUPABASE_URL)");
  }
  if (hits.length > 0) {
    throw new IntegrationProductionGuardError(
      `통합 테스트 대상이 Production Supabase(${KNOWN_PRODUCTION_PROJECT_REFS.join(", ")})입니다 — 감지된 설정: ${[...new Set(hits)].join(", ")}.\n` +
        `Production DB에서는 integration test를 실행할 수 없습니다. 개발/테스트 전용 Supabase 프로젝트를 사용하세요(.env.test.local 또는 CI Secrets).\n` +
        `(의도적인 Production QA는 별도 runner: npm run qa:production:* — QA_TARGET_PROJECT_REF / QA_PRODUCTION_ACK=1 필요)`
    );
  }
}
