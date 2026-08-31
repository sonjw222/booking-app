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

  보안: next는 반드시 "/"로 시작하는 내부 상대경로만 허용한다(오픈 리다이렉트 방지 —
  "/login?next=https://evil.com" 같은 외부 주소로 유도되지 않도록).
*/

const KEY = "post_login_next";

export function stashPostLoginNext(next: string | null | undefined): void {
  if (next && next.startsWith("/") && !next.startsWith("//")) {
    sessionStorage.setItem(KEY, next);
  }
}

export function consumePostLoginNext(): string | null {
  const v = sessionStorage.getItem(KEY);
  if (v) sessionStorage.removeItem(KEY);
  return v;
}

// 현재 화면(경로+쿼리)을 /login?next=... 링크에 그대로 쓰기 위한 헬퍼.
export function loginHrefWithReturnToHere(): string {
  if (typeof window === "undefined") return "/login";
  return `/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`;
}
