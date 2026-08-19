// 카카오 로그인 시작(authorize URL 리다이렉트) — Supabase 기본 제공 Kakao provider는
// account_email 스코프를 강제로 같이 요청해서 이 프로젝트(이메일 항목 미승인)에서는 쓸 수
// 없다(AUTH_SETUP.md 3-1절, supabase/functions/kakao-login). lib/naverAuth.ts와 완전히
// 같은 패턴 — app/login/page.tsx와 app/login/kakao-callback/page.tsx가 이 상수/함수를
// 공유해야 state 값이 어긋나지 않는다.

export const KAKAO_OAUTH_STATE_KEY = "kakao-oauth-state";

export function kakaoCallbackUrl(): string {
  return `${window.location.origin}/login/kakao-callback`;
}

export function startKakaoLogin(clientId: string): void {
  const state = crypto.randomUUID();
  sessionStorage.setItem(KAKAO_OAUTH_STATE_KEY, state);

  const url = new URL("https://kauth.kakao.com/oauth/authorize");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", kakaoCallbackUrl());
  url.searchParams.set("scope", "profile_nickname");
  url.searchParams.set("state", state);

  window.location.href = url.toString();
}
