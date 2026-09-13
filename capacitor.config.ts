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
  // 실기기 진단(2026-09-11) — 이 값이 없으면 네이티브 WKWebView/UIScrollView 자체의
  // 배경색이 iOS 기본값(검정에 가까움)으로 남아, 위/아래로 당겨 튕기는(rubber-band
  // overscroll) 구간에서 앱 배경(var(--bg), #0A2545 계열)이 아니라 그 네이티브 기본색이
  // 드러난다 — html/body에 CSS background를 줘도(app/globals.css) 이 레이어는 CSS가
  // 그리는 문서 영역 밖이라 안 먹는다. 앱 전체 배경색/스플래시와 동일한 값으로 맞춘다.
  backgroundColor: "#0A2545",
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
  plugins: {
    // 실기기 진단(2026-09-11) — 이 앱은 server.url 모드라(위 주석) WebView가 로컬 번들이
    // 아니라 실제 네트워크로 mwhabit.com을 불러온다. launchAutoHide 기본값(true)은
    // WebView 네비게이션이 "시작"되면 곧바로 네이티브 스플래시를 내려버려서, 실제 페이지
    // 로딩(네트워크 왕복 + CSS/폰트/이미지)이 끝나기 전에 스플래시가 사라지고 그 사이
    // 빈 화면/미완성 레이아웃이 잠깐 보이는 문제가 있었다 — "첫 실행 Splash가 이상하게
    // 보였다"는 실기기 증상의 유력한 원인. 자동 숨김을 끄고 대신
    // app/components/CapacitorBootstrap.tsx가 window 'load' 이벤트(리소스까지 전부 로드
    // 완료)를 기다린 뒤 명시적으로 SplashScreen.hide()를 부르도록 바꿨다.
    SplashScreen: {
      launchAutoHide: false,
    },
  },
};

export default config;
