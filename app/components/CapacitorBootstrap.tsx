"use client";

/*
  네이티브 앱(Capacitor) 전용 초기화 — 웹 배포에서는 Capacitor.isNativePlatform()이
  항상 false라 이 컴포넌트는 완전히 no-op이다(렌더링하는 UI도 없음, root layout에
  마운트만 해두면 됨).
  - 스플래시 화면을 첫 페인트 이후 닫는다(그냥 두면 계속 떠 있음).
  - 상태바를 WebView 위에 오버레이시켜 기존 safe-area-inset-* CSS(app/globals.css)가
    그대로 여백을 잡아주도록 한다.
  - 푸시 알림 탭 시 알림에 담긴 링크로 이동한다(lib/nativePush.ts,
    public/sw.js의 notificationclick과 동일 개념) — 이 앱은 <Link> 대신 일반 <a href>를
    쓰는 전체 페이지 로드 방식이라(app/layout.tsx 주석 참고) 여기도 동일하게 맞춘다.
*/

import { useEffect } from "react";
import { Capacitor } from "@capacitor/core";

export default function CapacitorBootstrap() {
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;

    (async () => {
      const [{ SplashScreen }, { StatusBar }, { registerNativePushTapHandler }] = await Promise.all([
        import("@capacitor/splash-screen"),
        import("@capacitor/status-bar"),
        import("../../lib/nativePush"),
      ]);

      await StatusBar.setOverlaysWebView({ overlay: true }).catch(() => {});
      await SplashScreen.hide().catch(() => {});
      registerNativePushTapHandler((link) => {
        window.location.href = link;
      });
    })();
  }, []);

  return null;
}
