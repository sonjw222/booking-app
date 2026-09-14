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

import { Capacitor, registerPlugin } from "@capacitor/core";

interface WebViewThemeNativePlugin {
  setBackground(options: { hex: string }): Promise<void>;
}

const WebViewThemeNative = registerPlugin<WebViewThemeNativePlugin>("WebViewTheme");

export function syncNativeWebViewBackground(dark: boolean): void {
  if (!Capacitor.isNativePlatform()) return;
  const hex = dark ? "#17181C" : "#FBFBFA";
  WebViewThemeNative.setBackground({ hex }).catch(() => { /* 웹/미지원 플랫폼 — 화면엔 영향 없음 */ });
}
