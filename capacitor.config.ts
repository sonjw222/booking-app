import type { CapacitorConfig } from "@capacitor/cli";

/*
  이 앱은 Next.js 서버 렌더링/API 라우트를 쓰는 동적 구조라 정적 export가 불가능하다
  (next.config.ts에 output:"export" 없음, app/api/payments/* 라우트 존재) — 그래서 로컬
  번들을 담지 않고 server.url 모드로 실제 배포된 프로덕션 사이트를 그대로 WebView에
  띄운다. 즉 이 파일을 바꾸고 npx cap sync만 다시 돌리면 앱을 스토어에 재제출하지 않고도
  반영된다(웹 배포와 동일한 코드가 그대로 열리는 것뿐이라서).

  appId(번들 ID)는 예외 — 스토어에 최초 제출하기 전까지는 자유롭게 바꿀 수 있지만,
  제출 이후에는 절대 바꿀 수 없다(대표님 확인, 2026-09-04: com.mwhabit.app으로 확정).
*/
const config: CapacitorConfig = {
  appId: "com.mwhabit.app",
  appName: "모하빗",
  webDir: "public", // server.url 모드에선 실제로 안 쓰이지만 Capacitor 스키마상 필수 필드
  server: {
    // 커스텀 도메인 연결 완료(2026-09-04, 실제 배포 응답 확인함)
    url: "https://mwhabit.com",
    cleartext: false,
    // 소셜 로그인이 전부 풀페이지 리다이렉트 방식이라(app/login/page.tsx, lib/kakaoAuth.ts,
    // lib/naverAuth.ts) 이 목록에 없는 도메인으로는 WebView가 이동 자체를 막는다.
    // Supabase 프로젝트 도메인은 signInWithOAuth()의 호스팅 인증 페이지 경유용.
    allowNavigation: [
      "kauth.kakao.com",
      "*.kakao.com",
      "nid.naver.com",
      "*.naver.com",
      "accounts.google.com",
      "*.google.com",
      "appleid.apple.com",
      "*.apple.com",
      "bxntqggkfwnhcczsbqtj.supabase.co",
    ],
  },
  ios: {
    // 기존 app/globals.css의 env(safe-area-inset-*) 레이아웃과 충돌을 최소화
    contentInset: "automatic",
  },
};

export default config;
