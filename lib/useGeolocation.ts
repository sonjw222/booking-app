"use client";

/*
  내 위치 훅 — 종목별 센터 목록의 거리 필터/정렬용.
  - 이미 허용된 경우(Permissions API가 granted)에는 프롬프트 없이 조용히 위치를 읽는다.
  - 아직 묻지 않았거나 거부된 경우에는 사용자가 거리 조건을 고르는 순간에만 request()로 요청한다(페이지 진입만으로 권한 팝업을 띄우지 않는다).
  - 상태: idle(아직 모름) / loading / granted / denied(권한 거부) / unavailable(기기/브라우저 미지원·타임아웃 등 실패)
*/
import { useCallback, useEffect, useRef, useState } from "react";
import type { Position } from "./centerDiscovery";

export type LocationStatus = "idle" | "loading" | "granted" | "denied" | "unavailable";

export function useGeolocation() {
  const [status, setStatus] = useState<LocationStatus>("idle");
  const [position, setPosition] = useState<Position | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const request = useCallback(() => {
    if (typeof navigator === "undefined" || !navigator.geolocation) { setStatus("unavailable"); return; }
    setStatus("loading");
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => { if (!alive.current) return; setPosition({ lat: coords.latitude, lng: coords.longitude }); setStatus("granted"); },
      (err) => { if (!alive.current) return; setStatus(err.code === 1 ? "denied" : "unavailable"); },
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 300000 },
    );
  }, []);

  useEffect(() => {
    let cancelled = false;
    const perms = typeof navigator !== "undefined" ? navigator.permissions : undefined;
    if (!perms?.query) return;
    perms.query({ name: "geolocation" as PermissionName }).then((p) => {
      if (cancelled) return;
      if (p.state === "granted") request();
      else if (p.state === "denied") setStatus("denied");
    }).catch(() => { /* Permissions API 미지원(Safari 등) — 사용자가 요청할 때까지 idle */ });
    return () => { cancelled = true; };
  }, [request]);

  return { status, position, request };
}
