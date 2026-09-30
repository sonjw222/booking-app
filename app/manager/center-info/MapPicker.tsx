"use client";

import SheetOverlay from "../../components/SheetOverlay";

/*
  지도에서 위치 지정 (API 키 불필요)
  - OpenStreetMap + Leaflet(CDN) — 지도 표시 + 클릭으로 핀 지정
  - 장소명/도로명주소 검색(Nominatim) — 결과 여러 개를 목록으로 보여주고 고르게 함
    (이전 버전은 limit=1로 첫 결과를 바로 써버려 사용자가 고를 수 없었다 — 수정)
  - "정확한 도로명 주소로 찾기" — 다음(카카오) 우편번호 서비스(lib/daumPostcode.ts,
    회원가입 폼의 AddressField가 이미 쓰는 것과 동일한 기존 인프라 재사용, 새 API 키 없음)
    한국 도로명주소 공식 DB라 Nominatim보다 정확 — 주소만 반환하므로 좌표는 그 주소 문자열을
    Nominatim으로 다시 지오코딩해서 붙인다(실패해도 주소 텍스트는 유지, 좌표는 지도를 눌러
    직접 지정하라고 안내 — 저장 자체를 막지 않음).
  - 지도 직접 클릭: 좌표 설정은 기존 그대로, 역지오코딩(Nominatim)으로 주소를 최선 노력으로
    채운다(이미 사용자가 입력해둔 주소는 덮어쓰지 않음 — 핀만 살짝 옮길 때 실수로 주소가
    사라지는 걸 방지).
  - 알려진 한계: Nominatim의 한국 도로명주소 인식 정확도는 다음 우편번호 서비스보다 낮다
    (실측 확인). 정확한 도로명주소가 필요하면 위 "정확한 도로명 주소로 찾기"를 쓰도록 안내.
*/

import { useEffect, useRef, useState } from "react";
import { searchAddress, geocodeAddress, reverseGeocode, type GeocodeResult } from "../../../lib/geocoding";
import { openDaumPostcode } from "../../../lib/daumPostcode";

type Props = {
  initialLat: number | null;
  initialLng: number | null;
  // address: 검색/역지오코딩으로 얻은 주소(최선 노력, 없을 수 있음) — 호출부가 무시해도
  // 기존처럼 동작한다(하위 호환, center-info/page.tsx는 3번째 인자를 안 받아도 그대로 동작).
  onPick: (lat: number, lng: number, address?: string) => void;
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
  // resolvedAddress: 검색 결과 선택 또는 역지오코딩으로 얻은 주소(최선 노력) — "이 위치로
  // 지정"을 누를 때 onPick의 3번째 인자로 넘어간다. 직접 입력한 주소를 덮어쓰는 게 아니라
  // "이 지도 흐름에서 마지막으로 확인된 주소"만 들고 있는 로컬 상태.
  const [resolvedAddress, setResolvedAddress] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<GeocodeResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [daumSearching, setDaumSearching] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const leafletRef = useRef<any>(null);
  const markerRef = useRef<any>(null);
  const mapObjRef = useRef<any>(null);

  function movePin(lat: number, lng: number) {
    setCoord({ lat, lng });
    const L = leafletRef.current, map = mapObjRef.current;
    if (map) {
      map.setView([lat, lng], 16);
      if (markerRef.current) markerRef.current.setLatLng([lat, lng]);
      else markerRef.current = L.marker([lat, lng]).addTo(map);
    }
  }

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
      map.on("click", async (e: any) => {
        const { lat, lng } = e.latlng;
        movePin(lat, lng);
        setResults([]);
        // 역지오코딩은 최선 노력 — 실패하거나 결과가 없으면(Nominatim이 이 좌표를 못 찾으면)
        // resolvedAddress를 그대로 null로 둔다. onPick에는 undefined로 전달되고, 호출부
        // (app/manager/rooms/page.tsx)는 undefined면 기존 주소 텍스트를 그대로 둔다 —
        // 좌표 지정 자체(및 저장)는 이 실패와 무관하게 이미 끝나 있다.
        const addr = await reverseGeocode(lat, lng);
        setResolvedAddress(addr);
      });
    }).catch((e) => setErr(e.message));
    return () => {
      cancelled = true;
      if (mapObjRef.current) { mapObjRef.current.remove(); mapObjRef.current = null; }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function doSearch() {
    if (!search.trim()) { setErr("검색어를 입력해 주세요."); return; }
    setErr(null); setNote(null); setSearching(true); setResults([]);
    try {
      const found = await searchAddress(search, 5);
      if (found.length === 0) { setErr("검색 결과가 없어요. 도로명이나 건물명을 다시 확인해 주세요."); return; }
      setResults(found);
    } catch (e: any) {
      setErr(e.message ?? "주소를 불러오지 못했어요. 잠시 후 다시 시도해 주세요.");
    } finally {
      setSearching(false);
    }
  }

  function pickResult(r: GeocodeResult) {
    movePin(r.lat, r.lng);
    setResolvedAddress(r.road ?? r.displayName);
    setResults([]);
    setSearch("");
  }

  // 정확한 도로명 주소로 찾기 — 다음 우편번호 서비스(기존 lib/daumPostcode.ts 재사용).
  // 주소만 정확히 주므로, 그 주소 문자열로 Nominatim 지오코딩을 한 번 더 해서 좌표를 붙인다.
  function openAccurateSearch() {
    setErr(null); setNote(null); setDaumSearching(true);
    openDaumPostcode(
      async (result) => {
        setDaumSearching(false);
        setResolvedAddress(result.roadAddress);
        const geo = await geocodeAddress(result.roadAddress);
        if (geo) {
          movePin(geo.lat, geo.lng);
        } else {
          // 주소는 정확히 확보했지만 좌표를 못 찾음 — 저장을 막지 않고, 지도를 눌러
          // 직접 좌표를 지정하도록 안내(이 프로젝트는 새 지오코딩 프로바이더를 추가하지 않음).
          setNote("주소는 찾았지만 좌표를 자동으로 찾지 못했어요. 지도를 눌러 정확한 위치에 핀을 찍어주세요.");
        }
      },
      () => setDaumSearching(false)
    ).catch((e: any) => {
      setDaumSearching(false);
      setErr(e.message ?? "주소 검색 서비스를 불러오지 못했어요.");
    });
  }

  return (
    <SheetOverlay className="sheet-overlay" onClick={onClose}>
      <div className="sheet map-picker-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-title">지도에서 위치 지정</div>
        <div className="map-search-row">
          <input
            className="input-field"
            placeholder="장소명 또는 도로명 주소 검색"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && doSearch()}
          />
          <button className="primary-btn small" disabled={searching} onClick={doSearch}>{searching ? "검색 중" : "검색"}</button>
        </div>
        <button type="button" className="text-btn map-daum-search-btn" disabled={daumSearching} onClick={openAccurateSearch}>
          {daumSearching ? "여는 중…" : "정확한 도로명 주소로 찾기"}
        </button>

        {results.length > 0 && (
          <ul className="map-search-results">
            {results.map((r, i) => (
              <li key={i}>
                <button type="button" className="map-search-result-item" onClick={() => pickResult(r)}>
                  <span className="map-search-result-main">{r.road ?? r.displayName}</span>
                  {r.jibun && <span className="map-search-result-sub">{r.jibun}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}

        {err && <div className="perm-guide is-error" style={{ margin: "4px 0" }}>{err}</div>}
        {note && <div className="perm-guide" style={{ margin: "4px 0" }}>{note}</div>}
        <div className="perm-guide" style={{ margin: "4px 0 8px" }}>지도를 눌러 센터 위치에 핀을 찍을 수도 있어요.</div>
        <div ref={mapRef} className="map-picker-canvas" />
        {coord && (
          <div className="perm-guide" style={{ margin: "8px 0 0" }}>
            선택됨: {coord.lat.toFixed(5)}, {coord.lng.toFixed(5)}
          </div>
        )}
        <div className="add-profile-actions" style={{ marginTop: 12 }}>
          <button className="ghost-btn" onClick={onClose}>취소</button>
          <button className="primary-btn" disabled={!coord} onClick={() => { if (coord) { onPick(coord.lat, coord.lng, resolvedAddress ?? undefined); onClose(); } }}>
            이 위치로 지정
          </button>
        </div>
      </div>
    </SheetOverlay>
  );
}
