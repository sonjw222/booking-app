import type { Metadata, Viewport } from "next";
import "./globals.css";
import "./workspace.css";
import { ImageViewerProvider } from "./components/ImageViewer";
import SessionWatcher from "./components/SessionWatcher";
import AppConfirmProvider from "./components/AppConfirmProvider";
import GlobalBottomNav from "./components/GlobalBottomNav";
import OfflineNotice from "./components/OfflineNotice";
import CapacitorBootstrap from "./components/CapacitorBootstrap";
import InteractiveGuard from "./components/InteractiveGuard";
import NavigationPolicy from "./components/NavigationPolicy";

export const metadata: Metadata = {
  title: "모하빗",
  description: "센터(스튜디오·체육관) 수업 예약과 회원 관리를 위한 모하빗",
};

export const viewport: Viewport = {
  themeColor: "#0A2545",
  // 실기기 진단(2026-09-11) — 이게 없으면 iOS WKWebView에서 CSS env(safe-area-inset-*)가
  // 전부 0으로 계산된다(스펙상 viewport-fit=cover가 있어야 값이 채워짐). 이미 여러 곳(예:
  // app/globals.css의 --floating-nav-clearance)이 env(safe-area-inset-bottom)에 기대고
  // 있었는데 이 메타가 빠져 있어 실제로는 항상 0으로 계산되고 있었다 — 하단 홈 인디케이터
  // 영역을 제대로 못 피하던 원인 중 하나. Capacitor의 StatusBar.setOverlaysWebView(true)
  // (CapacitorBootstrap.tsx)는 상태바를 오버레이하는 것과 별개로, 이 메타 자체가 있어야
  // safe-area 값을 CSS가 실제로 읽을 수 있다.
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="ko"
      // data-theme는 아래 인라인 스크립트가 하이드레이션 전에 클라이언트에서만 붙인다
      // (서버는 localStorage를 모름) — 이 경우의 불일치는 의도된 것이므로 React가
      // hydration mismatch 콘솔 에러를 내지 않도록 명시적으로 억제한다.
      suppressHydrationWarning
    >
      <head>
        {/* 2026-10-03 뒤로가기 white flash 대응(웹 첫 paint 레이어): 이 테마 스크립트를 <body> 안이 아니라 <head> 맨 앞으로 옮겨 첫 paint 이전에 data-theme와
            documentElement.style.colorScheme을 확정한다(canvas/기본 배경이 다크일 때 흰색으로 먼저 그려지지 않게). 같은 이유로 html/body의 background transition은 제거했다
            (globals.css) — 라이트 기본값(--bg)에서 다크로 0.2초 동안 "페이드"되며 뒤로가기/복원 직후 흰 프레임이 보였다. */}
        {/* 테마 즉시 적용(깜빡임 방지). app/settings/theme/page.tsx는 그 화면 안에서만
            data-theme를 적용했고, 다른 어떤 화면에도 이 값을 다시 적용하는 로직이 없어서
            테마 설정 화면을 벗어나는 순간(이 앱은 <Link> 대신 일반 <a href>를 써서 전체
            페이지가 다시 로드됨) 곧바로 라이트 모드로 돌아가던 버그를 고친다. React
            하이드레이션보다 먼저 동기 실행돼야 해서 인라인 스크립트로 넣는다.
            "system"(또는 저장된 값이 없음)이면 OS 다크모드 설정을 따른다 — 이 해석
            로직은 app/settings/theme/page.tsx의 resolveEffectiveTheme()과 동일해야
            한다(하이드레이션 전/후 결과가 달라지면 화면이 깜빡임).

            릴리스 폴리시 배치(2026-09-14, 2차) — iOS 오버스크롤 다크모드 대응: 여기서 정한
            dark 여부를 네이티브 WKWebView 배경(ios/App/App/WebViewThemePlugin.swift,
            SceneDelegate.swift가 이미 시스템 설정 기준 동적 색을 baseline으로 깔아둠)에도
            그대로 반영한다 — "시스템 설정 따르기"가 아니라 앱에서 명시적으로 고른 테마가
            시스템 설정과 다른 경우까지 커버하려면 이 시점에 실제 적용된 값을 네이티브에
            알려줘야 한다. WebViewTheme 플러그인 자체는 iOS 전용(Android 구현 없음)이라
            window.Capacitor.Plugins.WebViewTheme가 Android/웹에서는 falsy라 조용히
            건너뛴다 — try/catch로 감싸 실패해도 화면엔 영향 없음.

            릴리스 폴리시 배치(2026-09-17, 7차) — 상태바 아이콘 색(iOS/Android 공통, 이미
            설치된 공식 @capacitor/status-bar) 동기화 추가: 지금까지 상태바 아이콘 색을
            한 번도 명시적으로 설정한 적이 없어서 기기 시스템 다크/라이트 설정만 따라갔다
            (Style.Default) — 폰은 라이트 모드인데 앱 안에서 차콜(다크) 테마를 고르면
            어두운 배경에 어두운 아이콘이 남아 거의 안 보이는 상태가 될 수 있었다.
            window.Capacitor.Plugins.StatusBar는 (WebViewTheme와 달리) iOS/Android 둘 다
            존재하는 공식 플러그인이라 이 한 번의 호출로 양쪽 다 해결된다. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var t=localStorage.getItem("app_theme");var dark=t==="charcoal"||((!t||t==="system")&&window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.style.colorScheme=dark?"dark":"light";if(dark)document.documentElement.setAttribute("data-theme","charcoal");else if(t==="burgundy")document.documentElement.setAttribute("data-theme","burgundy");try{window.Capacitor&&window.Capacitor.Plugins&&window.Capacitor.Plugins.WebViewTheme&&window.Capacitor.Plugins.WebViewTheme.setBackground({hex:dark?"#17181C":"#FBFBFA"});}catch(e2){}try{window.Capacitor&&window.Capacitor.Plugins&&window.Capacitor.Plugins.StatusBar&&window.Capacitor.Plugins.StatusBar.setStyle({style:dark?"DARK":"LIGHT"});window.Capacitor&&window.Capacitor.getPlatform&&window.Capacitor.getPlatform()==="android"&&window.Capacitor.Plugins&&window.Capacitor.Plugins.AndroidStatusBarBackground&&window.Capacitor.Plugins.AndroidStatusBarBackground.setDark({dark:dark});}catch(e3){}}catch(e){}`,
          }}
        />
      </head>
      <body>
        {/* 토스 결제 SDK는 전역으로 로드하지 않는다(2026-10-02) — lib/tossSdk.ts loadTossSdk()가 checkout/카드등록 화면에서만 온디맨드 로드 */}
        <CapacitorBootstrap />
        <OfflineNotice />
        <InteractiveGuard />
        <NavigationPolicy />
        <SessionWatcher />
        <AppConfirmProvider />
        <ImageViewerProvider>{children}</ImageViewerProvider>
        <GlobalBottomNav />
      </body>
    </html>
  );
}
