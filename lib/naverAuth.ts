// 네이버 로그인 시작(authorize URL 리다이렉트) — Supabase가 기본 지원하지 않는 provider라
// app/login/page.tsx와 app/login/naver-callback/page.tsx 둘 다 이 상수/함수를 공유해야
// state 값이 어긋나지 않는다(AUTH_SETUP.md 3-3절, supabase/functions/naver-login).

export const NAVER_OAUTH_STATE_KEY = "naver-oauth-state";

export function naverCallbackUrl(): string {
  return `${window.location.origin}/login/naver-callback`;
}

// CSRF 방지용 1회성 state 값. crypto.randomUUID는 모든 지원 브라우저(HTTPS 컨텍스트)에서
// 쓸 수 있어 별도 폴리필이 필요 없다.
export function startNaverLogin(clientId: string): void {
  const state = crypto.randomUUID();
  sessionStorage.setItem(NAVER_OAUTH_STATE_KEY, state);

  const url = new URL("https://nid.naver.com/oauth2.0/authorize");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", naverCallbackUrl());
  url.searchParams.set("state", state);

  window.location.href = url.toString();
}
