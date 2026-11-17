"use client";

/*
  릴리스 폴리시 배치 8차(2026-09-17) — Root Navigation 정책 적용부.
  root layout에 CapacitorBootstrap과 함께 한 번만 마운트된다(회원/관리자/운영자 각 root
  탭들은 이제 SPA 전환이라 이 컴포넌트는 리마운트되지 않고 usePathname()만 갱신됨). 경로가
  바뀔 때마다:
  1. lib/navState.ts의 rootNavState를 갱신 — CapacitorBootstrap의 backButton 리스너(Android
     하드웨어/제스처 back)가 이 값을 읽어 root 화면에서는 이전 화면으로 못 돌아가게 한다.
  2. iOS WKWebView의 edge-swipe(allowsBackForwardNavigationGestures)를 root 화면에서는
     끄고, 상세 화면에서는 켠다(lib/edgeSwipe.ts).
  화면에 아무것도 렌더링하지 않는다.
*/
import { useEffect, useRef } from "react";
import { usePathname, useRouter } from "next/navigation";
import { updateRootNavState } from "../../lib/navState";
import { setEdgeSwipeEnabled } from "../../lib/edgeSwipe";
import { trackAppHistory } from "../../lib/appHistory";
import { Capacitor } from "@capacitor/core";
import { installBackBridge } from "../../lib/backPolicy";

export default function NavigationPolicy() {
  const pathname = usePathname();
  const router = useRouter();
  const pathRef = useRef(pathname);
  useEffect(() => { pathRef.current = pathname; }, [pathname]);

  // 단일 back 정책(lib/backPolicy.ts) 입구 — iOS 네이티브 왼쪽 가장자리 pan 이 window.__mwhabitBack 을 호출한다.
  useEffect(() => installBackBridge(router, () => pathRef.current, { iosNative: Capacitor.getPlatform() === "ios" }), [router]);

  useEffect(() => { trackAppHistory(pathname); }, [pathname]);

  useEffect(() => {
    const isRoot = updateRootNavState(pathname);
    setEdgeSwipeEnabled(!isRoot);
  }, [pathname]);

  return null;
}
