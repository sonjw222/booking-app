/*
  사용자 화면에 노출되는 오류 메시지를 안전한 한국어 문구로 바꾸는 공용 헬퍼(2026-09-29).

  배경: 실기기 QA에서 `duplicate key value violates unique constraint "accounts_phone_key"`
  같은 raw Postgres 오류가 그대로 화면에 보인 사례가 발견됐다(app/login/page.tsx의
  `"계정 생성 중 문제가 발생했어요: " + accErr.message` 패턴). 이 프로젝트의 서버 쪽
  `raise exception '...'` 메시지는 전부(1,100개 이상 확인) 이미 한글이라, "메시지에 한글이
  없으면 기술적인 raw 오류로 간주해 안전한 기본 문구로 치환"하는 방식이 안전하다 — 이미
  잘 만들어둔 한글 안내 메시지는 그대로 통과시키고, PostgREST/Postgres/네트워크/영문
  SDK 오류만 골라서 바꾼다.

  범위: 이번 배치에서 인증/회원가입/센터등록/결제/예약 핵심 흐름에 적용했다(최종 보고서의
  "알려진 제한" 참고 — 프로젝트 전체 58개 이상의 `.message` 사용처를 전부 훑는 것은 이번
  배치 범위를 넘는다).

  개발 로그에는 원본 오류를 그대로 남긴다(console.error) — 화면에만 안전한 문구를 보여주고
  디버깅 정보를 잃지 않는다.
*/

// 자주 나오는 특정 원인 → 구체적인 한국어 안내(가장 먼저 확인, 우선순위 높음).
const KNOWN_PATTERNS: { test: RegExp; message: string }[] = [
  { test: /accounts_phone_key/i, message: "이미 가입된 휴대폰 번호예요. 기존 계정으로 로그인해 주세요." },
  { test: /accounts_auth_id_key/i, message: "이미 등록된 계정이에요. 기존 계정으로 로그인해 주세요." },
  { test: /already registered|already been registered|user already exists/i, message: "이미 가입된 이메일이에요. 기존 계정으로 로그인해 주세요." },
  { test: /invalid login credentials/i, message: "이메일 또는 비밀번호가 올바르지 않아요." },
  { test: /email not confirmed/i, message: "이메일 인증이 아직 완료되지 않았어요. 메일함을 확인해주세요." },
  { test: /password should be/i, message: "비밀번호는 6자 이상이어야 해요." },
  { test: /rate limit/i, message: "너무 많이 시도했어요. 잠시 후 다시 시도해 주세요." },
  { test: /load failed|failed to fetch|network ?error|err_internet_disconnected|err_network/i, message: "네트워크 연결을 확인한 후 다시 시도해 주세요." },
  { test: /jwt|pgrst\d+|permission denied for|row-level security/i, message: "처리 중 문제가 발생했어요. 잠시 후 다시 시도해 주세요." },
];

// raw Postgres/PostgREST 기술 오류로 판단할 신호(한글 메시지에는 절대 나오지 않는 패턴들).
const RAW_TECHNICAL_SIGNS =
  /violates .* constraint|duplicate key value|relation ".*" does not exist|column ".*" does not exist|null value in column|invalid input syntax|permission denied for|unexpected token|syntax error at or near|^{.*}$|^\[.*\]$/i;

function extractMessage(error: unknown): string {
  if (error == null) return "";
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message ?? "";
  if (typeof error === "object" && "message" in error) {
    const m = (error as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  return "";
}

// 이 문자열에 한글(가-힣)이 하나도 없으면, 이 프로젝트의 관례상(모든 사용자 대상 메시지는
// 한글) raw 기술 오류일 가능성이 매우 높다.
function hasHangul(text: string): boolean {
  return /[가-힣]/.test(text);
}

export const DEFAULT_USER_ERROR_MESSAGE = "처리 중 문제가 발생했어요. 잠시 후 다시 시도해 주세요.";

/**
 * 어떤 형태의 오류(Error, Supabase/PostgREST 오류 객체, 문자열)든 안전한 한국어 사용자
 * 메시지로 변환한다. 이미 한글로 잘 만들어진 메시지(우리 RPC의 raise exception 등)는
 * 그대로 통과시키고, 영문/raw DB 오류만 fallback으로 치환한다.
 */
export function toUserMessage(error: unknown, fallback: string = DEFAULT_USER_ERROR_MESSAGE): string {
  const raw = extractMessage(error).trim();
  if (!raw) return fallback;

  // 디버깅용 — 사용자 화면에는 영향 없음.
  console.error("[toUserMessage]", error);

  for (const { test, message } of KNOWN_PATTERNS) {
    if (test.test(raw)) return message;
  }

  if (RAW_TECHNICAL_SIGNS.test(raw)) return fallback;
  if (!hasHangul(raw)) return fallback; // 한글이 전혀 없는 메시지 = 영문 raw 오류로 간주
  return raw; // 이미 안전한 한글 메시지 — 그대로 사용
}
