"use client";

/*
  지도에서 위치 지정 (API 키 불필요)
  - OpenStreetMap + Leaflet(CDN)
  - 주소 검색(Nominatim) + 지도 클릭으로 핀 지정 → 좌표 반환
*/

import { useEffect, useRef, useState } from "react";

type Props = {
  initialLat: number | null;
  initialLng: number | null;
  onPick: (lat: number, lng: number) => void;
  onClose: () => void;
};

// Leaflet CDN 로더 (한 번만)
function loadLeaflet(): Promise<any> {
  return new Promise((resolve, reject) => {
    if ((window as any).L) return resolve((window as any).L);
    // CSS
    if (!document.getElementById("leaflet-css")) {
      const link = document.createElement("link");
      link.id = "leaflet-css";
      link.rel = "stylesheet";
      link.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
      document.head.appendChild(link);
    }
    const script = document.createElement("script");
    script.src = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
    script.onload = () => resolve((window as any).L);
    script.onerror = () => reject(new Error("지도를 불러오지 못했어요"));
    document.body.appendChild(script);
  });
}

export default function MapPicker({ initialLat, initialLng, onPick, onClose }: Props) {
  const mapRef = useRef<HTMLDivElement>(null);
  const [coord, setCoord] = useState<{ lat: number; lng: number } | null>(
    initialLat != null && initialLng != null ? { lat: initialLat, lng: initialLng } : null
  );
  const [search, setSearch] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const leafletRef = useRef<any>(null);
  const markerRef = useRef<any>(null);
  const mapObjRef = useRef<any>(null);

  useEffect(() => {
    let cancelled = false;
    loadLeaflet().then((L) => {
      if (cancelled || !mapRef.current) return;
      leafletRef.current = L;
      const start = coord ?? { lat: 37.5665, lng: 126.9780 }; // 서울시청 기본
      const map = L.map(mapRef.current).setView([start.lat, start.lng], coord ? 16 : 12);
      mapObjRef.current = map;
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: "© OpenStreetMap",
        maxZoom: 19,
      }).addTo(map);

      if (coord) {
        markerRef.current = L.marker([coord.lat, coord.lng]).addTo(map);
      }
      map.on("click", (e: any) => {
        const { lat, lng } = e.latlng;
        setCoord({ lat, lng });
        if (markerRef.current) markerRef.current.setLatLng([lat, lng]);
        else markerRef.current = L.marker([lat, lng]).addTo(map);
      });
    }).catch((e) => setErr(e.message));
    return () => {
      cancelled = true;
      if (mapObjRef.current) { mapObjRef.current.remove(); mapObjRef.current = null; }
    };
  }, []);

  async function doSearch() {
    if (!search.trim()) return;
    setErr(null);
    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(search)}`,
        { headers: { "Accept-Language": "ko" } }
      );
      const data = await res.json();
      if (!data || data.length === 0) { setErr("검색 결과가 없어요"); return; }
      const lat = parseFloat(data[0].lat), lng = parseFloat(data[0].lon);
      setCoord({ lat, lng });
      const L = leafletRef.current, map = mapObjRef.current;
      if (map) {
        map.setView([lat, lng], 16);
        if (markerRef.current) markerRef.current.setLatLng([lat, lng]);
        else markerRef.current = L.marker([lat, lng]).addTo(map);
      }
    } catch { setErr("검색에 실패했어요"); }
  }

  return (
    <div className="sheet-overlay" onClick={onClose}>
      <div className="sheet map-picker-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-title">지도에서 위치 지정</div>
        <div className="map-search-row">
          <input
            className="input-field"
            placeholder="주소나 건물명 검색"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && doSearch()}
          />
          <button className="primary-btn small" onClick={doSearch}>검색</button>
        </div>
        {err && <div className="perm-guide" style={{ margin: "4px 0", color: "#c0392b" }}>{err}</div>}
        <div className="perm-guide" style={{ margin: "4px 0 8px" }}>지도를 눌러 센터 위치에 핀을 찍으세요.</div>
        <div ref={mapRef} className="map-picker-canvas" />
        {coord && (
          <div className="perm-guide" style={{ margin: "8px 0 0" }}>
            선택됨: {coord.lat.toFixed(5)}, {coord.lng.toFixed(5)}
          </div>
        )}
        <div className="add-profile-actions" style={{ marginTop: 12 }}>
          <button className="ghost-btn" onClick={onClose}>취소</button>
          <button className="primary-btn" disabled={!coord} onClick={() => { if (coord) { onPick(coord.lat, coord.lng); onClose(); } }}>
            이 위치로 지정
          </button>
        </div>
      </div>
    </div>
  );
}
