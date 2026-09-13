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

      // 실기기 진단(2026-09-11) — 이 앱은 server.url 모드라 WebView가 실제 네트워크로
      // mwhabit.com을 불러온다. capacitor.config.ts에서 launchAutoHide를 껐으니, 여기서도
      // 이 useEffect가 도는 시점(React 하이드레이션 완료)이 아니라 문서의 모든 리소스
      // (이미지/폰트 등)가 실제로 로드 완료된 시점(window "load")까지 기다렸다가 숨긴다 —
      // 안 그러면 네트워크가 느릴 때 스플래시가 내려간 자리에 아직 다 안 그려진 페이지가
      // 잠깐 보일 수 있다. 이미 로드가 끝난 뒤(document.readyState === "complete")라면
      // 바로 숨긴다.
      const hideSplash = () => SplashScreen.hide().catch(() => {});
      if (document.readyState === "complete") {
        await hideSplash();
      } else {
        window.addEventListener("load", () => { void hideSplash(); }, { once: true });
      }

      registerNativePushTapHandler((link) => {
        window.location.href = link;
      });
    })();
  }, []);

  return null;
}
