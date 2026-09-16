"use client";

/*
  네이티브 앱(Capacitor) 전용 초기화 — 웹 배포에서는 Capacitor.isNativePlatform()이
  항상 false라 이 컴포넌트는 완전히 no-op이다(렌더링하는 UI도 없음, root layout에
  마운트만 해두면 됨).
  - 스플래시 화면을 첫 페인트 이후 닫는다(그냥 두면 계속 떠 있음).
  - 상태바 오버레이(overlaysWebView)는 여기서 JS로 매번 다시 설정하지 않는다 —
    releasePolish 6차(2026-09-15)에서 capacitor.config.ts의 StatusBar.overlaysWebView
    선언적 설정으로 옮겼다(@capacitor/status-bar의 StatusBarPlugin.swift `load()`가
    네이티브 브릿지 초기화 시점에 이 config를 읽어 최초 페인트 "전"에 이미 적용한다 —
    JS 브릿지 호출 왕복이 전혀 필요 없다). 이 앱은 탭 전환마다 전체 페이지가 새로
    로드되는 구조라(app/layout.tsx 주석 참고) 이 useEffect도 매 페이지 로드마다 새로
    실행되는데, 예전처럼 여기서 매번 setOverlaysWebView({overlay:true})를 다시
    호출하면(이미 config로 true인 값을 또 true로 재적용) 불필요한 네이티브 브릿지
    왕복이 첫 페인트 "이후"에 한 번 더 발생해 상태바/safe-area 레이아웃이 순간적으로
    다시 계산되는 창을 만든다 — 홈 화면 상단 텍스트가 상태바와 겹쳐 보인다는 신고가
    CSS 자체(env(safe-area-inset-top) 값)는 맞는데도 반복된 근본 원인으로 진단됨.
    config 쪽만 신뢰하고 이 JS 호출은 제거한다.
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
      const [{ SplashScreen }, { App }, { registerNativePushTapHandler }] = await Promise.all([
        import("@capacitor/splash-screen"),
        import("@capacitor/app"),
        import("../../lib/nativePush"),
      ]);

      // Android 실기기 QA(2026-09-14, 4차) — Capacitor의 기본 하드웨어/제스처 back 처리는
      // "WebView 히스토리가 있으면 뒤로가기, 없으면 아무것도 안 함"이라(App/android의
      // AppPlugin.java 확인 — backButton JS 리스너가 없으면 이 기본값만 동작), 루트 화면
      // (첫 진입, 뒤로 갈 히스토리 없음)에서 시스템 백을 눌러도 반응이 없었다(Android
      // 표준 UX는 앱을 백그라운드로 보내야 함). 새 네이티브 코드 없이 Capacitor 공식
      // backButton 리스너(App 플러그인 공식 문서 예시와 동일 패턴)만 추가 — canGoBack이면
      // 기존과 동일하게 히스토리를 따라가고, 더 갈 곳이 없을 때만 앱을 종료(백그라운드)한다.
      // exitApp()은 iOS에서는 공식적으로 no-op이라(Apple 정책상 앱 자체 종료 불가) 이
      // 리스너를 플랫폼 분기 없이 그대로 둬도 안전하다.
      App.addListener("backButton", ({ canGoBack }) => {
        if (canGoBack) window.history.back();
        else App.exitApp();
      });

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
