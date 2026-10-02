"use client";

/*
  네이티브 앱 오프라인 안내 — 요청이 무한 로딩처럼 보이지 않게 작은 배너만 보여 준다(연결이 복구되면 자동으로 사라짐).
  기존 fetch/API 오류 처리는 그대로이고, 웹/플러그인 없는 구버전 앱에서는 아무것도 하지 않는다. root layout에서 한 번만 마운트된다.
*/
import { useEffect, useState } from "react";
import { Capacitor } from "@capacitor/core";

export default function OfflineNotice() {
  const [offline, setOffline] = useState(false);
  useEffect(() => {
    if (!Capacitor.isNativePlatform() || !Capacitor.isPluginAvailable("Network")) return;
    let alive = true;
    let remove: (() => void) | null = null;
    (async () => {
      try {
        const { Network } = await import("@capacitor/network");
        const status = await Network.getStatus();
        if (alive) setOffline(!status.connected);
        const handle = await Network.addListener("networkStatusChange", (s) => { if (alive) setOffline((prev) => (prev === !s.connected ? prev : !s.connected)); });
        remove = () => { void handle.remove(); };
      } catch { /* 부가 기능 — 실패하면 배너만 없다 */ }
    })();
    return () => { alive = false; remove?.(); };
  }, []);
  if (!offline) return null;
  return <div className="offline-notice" role="status" aria-live="polite">인터넷 연결이 끊겼어요. 연결되면 자동으로 다시 시도할 수 있어요.</div>;
}
