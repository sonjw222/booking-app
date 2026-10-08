// 클라이언트 오류 보고 기반(2026-10-08) — app/error.tsx, app/global-error.tsx가 쓰는 단일 진입점.
//
// 목적: 지금까지 화면 오류(렌더 예외)가 어디에도 남지 않아 사용자 신고 전에는 알 수 없었다. 이 모듈은
//  1) 오류를 구조화된 레코드로 만들고(개인정보/비밀값 제거),
//  2) 등록된 reporter(없으면 console 기본 sink)로 한 번 보낸다.
// 새 유료 SaaS를 가정하지 않는다 — DSN/키가 없어도 앱은 그대로 동작한다. 나중에 Sentry 등을 붙일 때는
// 앱 시작 지점에서 registerErrorReporter((record) => Sentry.captureException(...))만 호출하면 되고,
// 화면 코드는 바뀌지 않는다.
//
// 레코드에 절대 넣지 않는 것: 이메일, 전화번호, JWT/Bearer/API 키처럼 보이는 토큰, URL의 query/hash(토큰·검색어가 들어갈 수 있음),
// 원문 요청 본문. 메시지/스택은 sanitize + 길이 제한을 거친다.

export type ClientErrorRecord = {
  source: string;          // 어디서 잡았는지("app/error", "app/global-error" 등)
  name: string;
  message: string;         // sanitize 후
  digest?: string;         // Next.js가 서버 렌더 오류에 붙이는 해시(서버 로그와 대조용)
  stack?: string;          // sanitize 후, 앞부분만
  path: string;            // location.pathname만(query/hash 제거)
  at: string;              // ISO 시각
};

export type ErrorReporter = (record: ClientErrorRecord) => void;

const MAX_MESSAGE = 300;
const MAX_STACK = 1500;

// 값 자체가 비밀/개인정보처럼 보이는 패턴을 가린다. 과하게 가려도 디버깅에는 오류 종류/위치면 충분하다.
const REDACTIONS: [RegExp, string][] = [
  [/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, "[jwt]"],                  // JWT
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [token]"],
  [/\b(sb_(?:secret|publishable)_[A-Za-z0-9_-]{6,})/g, "[key]"],
  [/\b(?:test|live)_(?:sk|ck|gsk|gck)_[A-Za-z0-9]{6,}/g, "[key]"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]"],
  [/\b01[016789][-\s]?\d{3,4}[-\s]?\d{4}\b/g, "[phone]"],
  [/([?&#](?:token|access_token|refresh_token|code|key|apikey|authKey|paymentKey|secret)=)[^&\s)]+/gi, "$1[redacted]"],
  [/\b[A-Fa-f0-9]{32,}\b/g, "[hex]"],
];

export function sanitizeText(input: unknown, max: number): string {
  let s = typeof input === "string" ? input : "";
  for (const [re, rep] of REDACTIONS) s = s.replace(re, rep);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function currentPath(): string {
  try { return typeof window !== "undefined" ? window.location.pathname : ""; } catch { return ""; }
}

export function buildClientErrorRecord(
  error: unknown,
  context: { source: string; digest?: string },
  now: () => Date = () => new Date(),
): ClientErrorRecord {
  const e = (error && typeof error === "object" ? error : {}) as { name?: unknown; message?: unknown; stack?: unknown; digest?: unknown };
  const digest = typeof context.digest === "string" ? context.digest : typeof e.digest === "string" ? e.digest : undefined;
  return {
    source: context.source,
    name: sanitizeText(typeof e.name === "string" ? e.name : "Error", 60),
    message: sanitizeText(typeof e.message === "string" ? e.message : String(error ?? ""), MAX_MESSAGE),
    ...(digest ? { digest: sanitizeText(digest, 64) } : {}),
    ...(typeof e.stack === "string" ? { stack: sanitizeText(e.stack, MAX_STACK) } : {}),
    path: currentPath(),
    at: now().toISOString(),
  };
}

let reporter: ErrorReporter | null = null;

// 향후 Sentry 등 연결 지점. null을 주면 기본 console sink로 되돌아간다.
export function registerErrorReporter(next: ErrorReporter | null): void {
  reporter = next;
}

function defaultSink(record: ClientErrorRecord): void {
  // 구조화(JSON) 한 줄 — 브라우저 콘솔/원격 디버깅/로그 수집기에서 검색하기 쉽게 접두어를 고정한다.
  console.error("[client-error]", JSON.stringify(record));
}

// 보고 실패가 화면 복구를 막아선 안 된다 — 어떤 예외도 삼킨다.
export function reportClientError(error: unknown, context: { source: string; digest?: string }): void {
  try {
    const record = buildClientErrorRecord(error, context);
    (reporter ?? defaultSink)(record);
  } catch {
    /* 보고 경로의 오류는 무시 */
  }
}
