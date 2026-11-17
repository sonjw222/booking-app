"use client";

/*
  지정된 위치를 보여주는 작은 지도 (읽기 전용)
  - OpenStreetMap + Leaflet (API 키 불필요)
  - 위치가 지정된 뒤 미리보기용
*/

import { useEffect, useRef } from "react";

type Props = { lat: number; lng: number; height?: number };

// 이 화면에서 쓰는 Leaflet API 의 최소 형태.
interface LeafletMap { setView(center: [number, number], zoom: number): LeafletMap; remove(): void }
interface LeafletLayer { addTo(map: LeafletMap): unknown }
interface LeafletLib {
  map(el: HTMLElement, options: Record<string, boolean>): LeafletMap;
  tileLayer(url: string, options: { attribution: string; maxZoom: number }): LeafletLayer;
  marker(latlng: [number, number]): LeafletLayer;
}
const leafletOf = (): LeafletLib | undefined => (window as unknown as { L?: LeafletLib }).L;

function loadLeaflet(): Promise<LeafletLib> {
  return new Promise((resolve, reject) => {
    const existing = leafletOf();
    if (existing) return resolve(existing);
    if (!document.getElementById("leaflet-css")) {
      const link = document.createElement("link");
      link.id = "leaflet-css";
      link.rel = "stylesheet";
      link.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
      document.head.appendChild(link);
    }
    const script = document.createElement("script");
    script.src = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
    script.onload = () => {
      const L = leafletOf();
      if (L) resolve(L); else reject(new Error("지도를 불러오지 못했어요"));
    };
    script.onerror = () => reject(new Error("지도를 불러오지 못했어요"));
    document.body.appendChild(script);
  });
}

export default function MapPreview({ lat, lng, height = 160 }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LeafletMap | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadLeaflet().then((L) => {
      if (cancelled || !ref.current) return;
      if (mapRef.current) { mapRef.current.remove(); mapRef.current = null; }
      const map = L.map(ref.current, {
        zoomControl: false, dragging: false, scrollWheelZoom: false,
        doubleClickZoom: false, boxZoom: false, keyboard: false, touchZoom: false,
      }).setView([lat, lng], 16);
      mapRef.current = map;
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: "© OpenStreetMap", maxZoom: 19,
      }).addTo(map);
      L.marker([lat, lng]).addTo(map);
    }).catch(() => { /* 지도 로드 실패는 조용히 무시 */ });
    return () => {
      cancelled = true;
      if (mapRef.current) { mapRef.current.remove(); mapRef.current = null; }
    };
  }, [lat, lng]);

  return <div ref={ref} className="map-preview" style={{ height }} />;
}
