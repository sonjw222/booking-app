/*
  iOS 전용 — WKWebView의 allowsBackForwardNavigationGestures(edge-swipe 뒤로가기)를 현재
  화면이 root destination인지에 따라 토글한다. 전역으로 항상 켜두면(SceneDelegate.swift,
  2026-09-15 QA 대응) "스와이프가 전혀 안 된다"는 문제는 해결되지만, root 화면(회원 5탭/
  관리자 4탭/운영자 1탭)에서는 반대로 edge swipe로 로그인 화면·이전 모드가 뒤에서 노출되는
  문제가 생긴다(릴리스 폴리시 배치 8차 QA 신고). ios/App/App/NavigationPolicyPlugin.swift가
  받는 쪽 — WebViewThemePlugin.swift와 동일한 선례(로컬 커스텀 플러그인, 신규 npm 의존성
  없음). Android는 edge-swipe 제스처 자체가 WebView에 없어(하드웨어/제스처 back은 전부
  CapacitorBootstrap.tsx의 backButton 리스너가 처리) 이 파일과 무관, 웹에서는 no-op.
*/
import { Capacitor } from "@capacitor/core";

export function setEdgeSwipeEnabled(enabled: boolean): void {
  try {
    if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== "ios") return;
    const plugin = (window as any).Capacitor?.Plugins?.NavigationPolicy;
    if (!plugin?.setEdgeSwipeEnabled) return;
    plugin.setEdgeSwipeEnabled({ enabled }).catch(() => {});
  } catch {
    /* 무시 — 실패해도 화면 동작에는 영향 없음(기존 전역 기본값 유지) */
  }
}
