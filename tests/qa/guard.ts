/*
  Production 전용 QA 안전장치(순수 함수 — 네트워크/Supabase 접근 없음, 단위 테스트 대상).
  이 저장소의 Supabase 프로젝트는 하나뿐이라(dev/prod 분리 없음) QA runner가 데이터를 만들거나 바꾸려면
  명시적으로 "이 프로젝트가 맞고, 변경해도 된다"를 두 번 확인해야 한다:
    1) QA_TARGET_PROJECT_REF — NEXT_PUBLIC_SUPABASE_URL에서 뽑은 project ref와 정확히 같아야 한다(다른 프로젝트 오조작 방지).
    2) QA_PRODUCTION_ACK=1 — Production mutation을 허용한다는 명시적 opt-in.
  값(키/비밀번호)은 어디에도 출력하지 않는다.
*/
export const PRODUCTION_PROJECT_REF = "bxntqggkfwnhcczsbqtj";

export class QaGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QaGuardError";
  }
}

// https://<ref>.supabase.co → "<ref>" (그 형태가 아니면 null)
export function projectRefFromUrl(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    const host = new URL(url).hostname;
    const m = /^([a-z0-9]{20})\.supabase\.(co|in)$/.exec(host);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

export type QaEnv = Record<string, string | undefined>;

// Production 데이터를 만들거나 바꾸는 모든 QA 명령의 첫 단계. 통과하면 project ref를 돌려준다.
export function assertProductionQaAllowed(env: QaEnv): { projectRef: string } {
  const urlRef = projectRefFromUrl(env.NEXT_PUBLIC_SUPABASE_URL);
  if (!urlRef) {
    throw new QaGuardError("NEXT_PUBLIC_SUPABASE_URL에서 Supabase project ref를 확인할 수 없어 QA를 중단합니다.");
  }
  const target = env.QA_TARGET_PROJECT_REF;
  if (!target) {
    throw new QaGuardError("QA_TARGET_PROJECT_REF가 설정되지 않았습니다. Production QA는 대상 project ref를 명시해야 실행됩니다.");
  }
  if (target !== urlRef) {
    throw new QaGuardError("QA_TARGET_PROJECT_REF가 NEXT_PUBLIC_SUPABASE_URL의 project ref와 달라 QA를 중단합니다(다른 프로젝트를 건드릴 수 있음).");
  }
  if (urlRef !== PRODUCTION_PROJECT_REF) {
    throw new QaGuardError("이 QA runner는 지정된 Production 프로젝트에만 사용할 수 있습니다. 대상 project ref가 등록된 값과 다릅니다.");
  }
  if (env.QA_PRODUCTION_ACK !== "1") {
    throw new QaGuardError("QA_PRODUCTION_ACK=1이 없어 Production 데이터를 변경하는 QA를 중단합니다(명시적 opt-in 필요).");
  }
  return { projectRef: urlRef };
}

// 필요한 env "이름"이 빠졌는지 확인한다(값은 확인만 하고 절대 출력하지 않는다).
export const QA_REQUIRED_ENV_NAMES = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "TEST_MANAGER_A_EMAIL",
  "TEST_MANAGER_A_PASSWORD",
  "TEST_USER_A_EMAIL",
  "TEST_USER_A_PASSWORD",
  "QA_TARGET_PROJECT_REF",
  "QA_PRODUCTION_ACK",
] as const;

export function missingQaEnvNames(env: QaEnv): string[] {
  return QA_REQUIRED_ENV_NAMES.filter((n) => !env[n]);
}
