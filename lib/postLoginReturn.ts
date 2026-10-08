/*
  로그인 때문에 하던 작업(결제, 장바구니, 예약 등)이 끊긴 경우, 로그인 완료 후 원래 있던
  화면으로 돌아가기 위한 공용 메커니즘.

  왜 세션스토리지인가: /login으로 들어오는 경로가 이메일/구글/애플/카카오/네이버 5갈래인데,
  구글·애플은 Supabase의 signInWithOAuth(redirectTo)가 리다이렉트를 관리하고, 카카오·네이버는
  커스텀 콜백 화면(app/login/*-callback/page.tsx)을 거친다 — 성공 경로마다 최종적으로 어느
  URL로 떨어지는지 형태가 제각각이다. 다행히 다섯 갈래 전부 최종적으로 홈("/")에 도착하도록
  이미 통일돼 있어서(각 페이지가 window.location.href = "/"), 그 홈 진입 시점 단 한 곳에서만
  실제 이동을 처리하면 다섯 갈래를 전부 따로 손댈 필요가 없다. sessionStorage는 이 리다이렉트
  체인(동일 탭, 동일 출처) 내내 유지된다.

  보안: next는 sanitizeNextPath()를 통과한 같은 출처 내부 경로만 허용한다(오픈 리다이렉트 방지 —
  "/login?next=https://evil.com", "//evil.com", "/\\evil.com", 인코딩/제어문자 변형 포함). 저장 시점과 이동 직전 두 번 검사한다.
*/

const KEY = "post_login_next";

// 로그인 후 이동 대상으로 허용하는 "같은 출처의 내부 경로"인지 검사한다(2026-10-08 보안 감사 P2 — 예전에는 startsWith("/") && !startsWith("//")만 봐서
// "/\\evil.com", "/\t/evil.com" 같은 값이 브라우저의 URL 정규화(백슬래시→슬래시, 탭/개행 제거)로 외부 호스트가 됐다).
// 통과하면 그 문자열 그대로, 아니면 null. 정상: "/checkout?center=..&product=..", "/reservation?openClassId=..". 차단: "//x", "/\\x", "https://x", 인코딩/제어문자 변형.
const MAX_NEXT_LENGTH = 2000;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
export function sanitizeNextPath(next: string | null | undefined): string | null {
  if (typeof next !== "string" || next.length === 0 || next.length > MAX_NEXT_LENGTH) return null;
  if (CONTROL_CHARS.test(next) || next.includes("\\")) return null;          // 탭/개행/제어문자·백슬래시는 브라우저가 슬래시/무시로 바꿔 외부 호스트를 만든다
  if (!next.startsWith("/") || next.startsWith("//")) return null;              // 절대 URL, 프로토콜 상대 URL 차단
  // 인코딩 변형: 최대 2번 디코드해 보고 그 결과가 외부/프로토콜 상대/백슬래시/제어문자가 되면 거부(예: "/%2F%2Fevil.com", "/%5Cevil.com", "/%252F%252Fevil.com")
  let decoded = next;
  for (let i = 0; i < 2; i++) {
    try { decoded = decodeURIComponent(decoded); } catch { return null; }
    if (CONTROL_CHARS.test(decoded) || decoded.includes("\\") || decoded.startsWith("//") || !decoded.startsWith("/")) return null;
  }
  // 최종 확인: 실제 URL 파서로 해석해도 같은 출처의 경로여야 한다.
  try {
    const base = "https://app.invalid";
    const u = new URL(next, base);
    if (u.origin !== base || !u.pathname.startsWith("/")) return null;
  } catch { return null; }
  return next;
}

export function stashPostLoginNext(next: string | null | undefined): void {
  const safe = sanitizeNextPath(next);
  if (safe) sessionStorage.setItem(KEY, safe);
}

export function consumePostLoginNext(): string | null {
  const v = sessionStorage.getItem(KEY);
  if (v) sessionStorage.removeItem(KEY);
  return sanitizeNextPath(v);   // 저장된 값도 이동 직전에 다시 검증한다(방어적 이중 확인)
}

// 현재 화면(경로+쿼리)을 /login?next=... 링크에 그대로 쓰기 위한 헬퍼.
export function loginHrefWithReturnToHere(): string {
  if (typeof window === "undefined") return "/login";
  return `/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`;
}
