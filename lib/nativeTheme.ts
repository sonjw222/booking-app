/*
  iOS WKWebView 오버스크롤(rubber-band) 배경색을 현재 실제 적용된 라이트/다크 테마에
  맞춰 네이티브로 알려준다 — ios/App/App/WebViewThemePlugin.swift(로컬 커스텀 Capacitor
  플러그인, FcmTokenPlugin.swift와 동일한 선례)를 감싼 얇은 래퍼.

  릴리스 폴리시 배치(2026-09-14, 2차) — SceneDelegate.swift가 앱 기동 시 iOS 시스템
  라이트/다크 설정을 따라가는 동적 색을 baseline으로 깔아두지만, 이 앱은 시스템 설정과
  별개로 사용자가 앱 안에서 직접 테마를 고를 수도 있다(app/settings/theme/page.tsx) —
  그 명시적 선택까지 오버스크롤 배경에 반영하려면 "지금 실제로 적용된 테마가 뭔지"를 JS가
  알려줘야 한다. app/layout.tsx의 하이드레이션 전 인라인 스크립트(콜드 스타트)와
  app/settings/theme/page.tsx의 applyTheme()(런타임 전환) 양쪽에서 호출한다 — 인라인
  스크립트 쪽은 번들 JS가 아직 로드되기 전이라 이 모듈을 직접 못 쓰므로 동일한 로직을
  raw JS 문자열로 중복 구현해뒀다(app/layout.tsx 주석 참고, 둘이 반드시 같은 결과를 내야
  함 — 테마 판정 로직 자체가 어긋나면 화면이 깜빡이는 것과 같은 이유).
*/

import { Capacitor, registerPlugin, SystemBars, SystemBarsStyle, SystemBarType } from "@capacitor/core";

interface WebViewThemeNativePlugin {
  setBackground(options: { hex: string }): Promise<void>;
}

interface AndroidStatusBarBackgroundNativePlugin {
  setDark(options: { dark: boolean }): Promise<void>;
}

const WebViewThemeNative = registerPlugin<WebViewThemeNativePlugin>("WebViewTheme");
const AndroidStatusBarBackgroundNative = registerPlugin<AndroidStatusBarBackgroundNativePlugin>("AndroidStatusBarBackground");

export function syncNativeWebViewBackground(dark: boolean): void {
  if (!Capacitor.isNativePlatform()) return;
  const hex = dark ? "#17181C" : "#FBFBFA";
  WebViewThemeNative.setBackground({ hex }).catch(() => { /* 웹/미지원 플랫폼 — 화면엔 영향 없음 */ });
}

// 릴리스 폴리시 배치 7차(2026-09-17) — Android edge-to-edge/상태바 전수 감사 중 발견:
// 이 앱은 시스템 다크/라이트 설정과 별개로 앱 안에서 직접 테마를 고를 수 있는데
// (app/settings/theme/page.tsx), 상태바 "아이콘 색"(글자/시계/배터리 등)은 지금까지
// 한 번도 명시적으로 설정한 적이 없었다 — iOS/Android 둘 다 Capacitor
// StatusBar(@capacitor/status-bar, 이미 설치돼 capacitor.config.ts에도 등록돼 있음)의
// 기본값(Style.Default = "기기의 시스템 다크/라이트 설정을 따름")에 그대로 맡겨져
// 있었다. 그 결과 "폰은 라이트 모드인데 앱 안에서는 차콜(다크) 테마를 고른" 사용자는
// 어두운 배경 위에 어두운 색 아이콘이 뜨는(대비 없이 거의 안 보이는) 상태가 될 수
// 있다 — WebViewTheme(오버스크롤 배경색, 이 파일의 syncNativeWebViewBackground)와
// 정확히 같은 이유·같은 두 호출 지점(app/layout.tsx의 하이드레이션 전 인라인
// 스크립트, 이 함수)에서 앱의 실제 적용 테마를 네이티브에 알려줘야 한다. 커스텀
// 플러그인을 새로 만들 필요 없이 이미 설치된 공식 @capacitor/status-bar 하나로
// iOS/Android 둘 다 해결된다(Style.Dark="어두운 배경용 밝은 글자", Style.Light="밝은
// 배경용 어두운 글자" — 공식 패키지 정의 주석 확인함, 이름이 반직관적이라 착각하기
// 쉬움).
// 2026-10-08 — Android는 @capacitor/status-bar 대신 Capacitor core의 SystemBars(modern API)로 상태바 아이콘 색을 정한다.
// 이유: Google Play가 Android 15/16에서 지원 중단된 Window.get/setStatusBarColor 사용을 경고하는데, 호출 위치가
// @capacitor/status-bar 8.0.3의 StatusBar.get/setStatusBarColorDeprecated였다(8.0.4도 Java 소스 동일 — 패치 업데이트로 해결 안 됨).
// SystemBars는 Capacitor 8 브릿지가 항상 등록하는 core 플러그인이라(Bridge.java) 새 네이티브 구성요소가 아니고, Android에서
// 같은 WindowInsetsControllerCompat.setAppearanceLightStatusBars(!dark)를 쓴다(SystemBarsStyle.Dark = Style.Dark와 같은 뜻:
// 어두운 배경용 밝은 아이콘). bar를 StatusBar로 한정해 이전 동작(상태바만 변경, 내비게이션 바는 그대로)을 유지한다.
// iOS는 기존 @capacitor/status-bar 경로를 그대로 쓴다(오버레이/safe-area 동작 변경 없음).
export async function syncNativeStatusBarStyle(dark: boolean): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  try {
    if (Capacitor.getPlatform() === "android") {
      await SystemBars.setStyle({ style: dark ? SystemBarsStyle.Dark : SystemBarsStyle.Light, bar: SystemBarType.StatusBar });
      await AndroidStatusBarBackgroundNative.setDark({ dark });
      return;
    }
    const { StatusBar, Style } = await import("@capacitor/status-bar");
    await StatusBar.setStyle({ style: dark ? Style.Dark : Style.Light });
  } catch {
    /* 웹/미지원 플랫폼 — 화면엔 영향 없음 */
  }
}
