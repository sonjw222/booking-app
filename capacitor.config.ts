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
  // overscroll) 구간에서 이 레이어가 그대로 드러난다 — html/body에 CSS background를 줘도
  // (app/globals.css) 이 레이어는 CSS가 그리는 문서 영역 밖이라 안 먹는다.
  //
  // 릴리스 폴리시 배치(2026-09-14) — 위 주석이 "앱 전체 배경색이 #0A2545 계열"이라고
  // 적고 그 값을 그대로 썼지만 실제로는 틀린 전제였다: app/globals.css의 --bg 토큰은
  // 라이트(기본)/버건디 테마 모두 #FBFBFA(거의 흰색)이고, #0A2545(네이비)는
  // LaunchScreen.storyboard의 스플래시 배경 및 app/layout.tsx의 viewport.themeColor일 뿐,
  // 실제 페이지 배경이었던 적이 없다. 그 결과 오버스크롤 시 네이티브 레이어(네이비)와
  // 실제 페이지 배경(거의 흰색)이 만나는 경계에 사용자가 보고한 "분리된 네이비 띠"가
  // 보였다 — 이 값을 실제 기본 페이지 배경(--bg 라이트값)과 맞춘다.
  // 릴리스 폴리시 배치(2026-09-14, 2차) — 위에서 남긴 "차콜(다크) 테마는 여전히 어긋난다"는
  // 한계를 마저 해결했다: 이 값은 여전히 정적이라 그 자체로는 다크 테마까지 못 맞추지만,
  // ios/App/App/SceneDelegate.swift가 브리지 초기화 직후 이 값을 iOS 시스템 라이트/다크
  // 설정을 자동으로 따라가는 동적 UIColor로 즉시 덮어쓰고, 앱 안에서 사용자가 명시적으로
  // 고른 테마(시스템 설정과 다를 수 있음)는 WebViewThemePlugin.swift를 통해 JS가 마저
  // 알려준다(app/layout.tsx 인라인 스크립트 + app/settings/theme/page.tsx의 applyTheme()).
  // 이 config 값 자체는 그 덮어쓰기 전 아주 짧은 순간의 안전한 기본값 역할만 한다.
  backgroundColor: "#FBFBFA",
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
    // 실기기 진단(2026-09-13, safe-area/status bar 겹침) — "automatic"은 네이티브
    // UIScrollView가 safe area만큼 콘텐츠를 자동으로 밀어내는 설정(contentInsetAdjustmentBehavior
    // = .automatic)인데, 이 앱은 이미 app/globals.css 전역에서 env(safe-area-inset-*)로
    // 직접 여백을 계산해 쓰고 있다(수십 곳). 네이티브 자동 inset과 CSS 수동 inset이
    // 동시에 적용되면 이중 여백/불일치가 생기고, 특히 이 앱처럼 화면 전환마다 전체
    // 페이지가 새로 로드되는 구조에서는 네이티브 inset이 재계산되는 시점과 CSS가
    // 페인트되는 시점이 어긋나 전환 프레임에 헤더와 상태바가 겹쳐 보이는 원인이 됐다.
    // Capacitor 공식 기본값이자 CSS로 직접 처리하는 앱에 권장되는 "never"로 되돌려
    // 네이티브 자동 inset을 끄고 전적으로 CSS에 위임한다.
    contentInset: "never",
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
