"use client";

/*
  종목별 센터 목록의 필터·정렬 시트 (거리 범위 + 정렬)
  - 모바일: 하단 시트(SheetOverlay 공용: 포커스 트랩/ESC/배경 탭/드래그 닫기), 넓은 화면: 같은 시트가 가운데 카드로 표시된다(CSS).
  - 선택은 즉시 목록에 반영되고, [적용]은 시트를 닫아 결과를 확인한다. 위치가 필요한 항목은 위치 상태에 따라 안내/재시도/위치 없이 보기를 제공한다.
*/
import SheetOverlay from "./SheetOverlay";
import UiIcon from "./UiIcon";
import {
  DISTANCE_OPTIONS, SORT_OPTIONS, radiusLabel, sortAvailability,
  type DiscoveryState, type RadiusKm, type SortKey,
} from "../../lib/centerDiscovery";
import type { LocationStatus } from "../../lib/useGeolocation";

type Props = {
  state: DiscoveryState;
  locationStatus: LocationStatus;
  hasPosition: boolean;
  ratingsLoaded: boolean;
  anyRated: boolean;
  resultCount: number;
  onChangeRadius: (r: RadiusKm) => void;
  onChangeSort: (s: SortKey) => void;
  onRequestLocation: () => void;
  onWithoutLocation: () => void;
  onReset: () => void;
  onClose: () => void;
};

export default function CenterFilterSheet(p: Props) {
  const needsLocationHelp = !p.hasPosition && (p.locationStatus === "denied" || p.locationStatus === "unavailable");
  return (
    <SheetOverlay className="sheet-overlay" onClick={p.onClose}>
      <div className="sheet center-filter-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-title">필터 · 정렬</div>

        <section className="cf-section" aria-labelledby="cf-distance-title">
          <h3 id="cf-distance-title">거리 범위</h3>
          <div className="cf-chips" role="radiogroup" aria-labelledby="cf-distance-title">
            {DISTANCE_OPTIONS.map((r) => (
              <button key={String(r)} type="button" role="radio" aria-checked={p.state.radiusKm === r}
                className={`cf-chip ${p.state.radiusKm === r ? "on" : ""}`} onClick={() => p.onChangeRadius(r)}>
                {radiusLabel(r)}
              </button>
            ))}
          </div>
          {p.locationStatus === "loading" && <p className="cf-note" role="status">내 위치를 확인하고 있어요…</p>}
          {needsLocationHelp && (
            <div className="cf-location" role="alert">
              <p><UiIcon name="location" size={16} />
                {p.locationStatus === "denied"
                  ? "위치 권한이 꺼져 있어 내 주변 센터를 찾을 수 없어요. 브라우저·기기 설정에서 위치를 허용한 뒤 다시 시도해 주세요."
                  : "현재 위치를 확인하지 못했어요. 잠시 후 다시 시도하거나 위치 없이 둘러볼 수 있어요."}
              </p>
              <div className="cf-location-actions">
                <button type="button" className="ghost-btn" onClick={p.onRequestLocation}>다시 시도</button>
                <button type="button" className="ghost-btn" onClick={p.onWithoutLocation}>위치 없이 보기</button>
              </div>
            </div>
          )}
          {!p.hasPosition && p.locationStatus === "idle" && p.state.radiusKm == null && (
            <p className="cf-note">거리 범위를 고르면 현재 위치를 사용해요. 위치 정보는 기기에서만 사용하고 저장하지 않아요.</p>
          )}
        </section>

        <section className="cf-section" aria-labelledby="cf-sort-title">
          <h3 id="cf-sort-title">정렬</h3>
          <div className="cf-sorts" role="radiogroup" aria-labelledby="cf-sort-title">
            {SORT_OPTIONS.map((o) => {
              const a = sortAvailability(o.key, { hasPosition: p.hasPosition, ratingsLoaded: p.ratingsLoaded, anyRated: p.anyRated });
              const selected = p.state.sort === o.key;
              // 위치가 없어서 비활성인 거리순은 눌러서 위치를 요청할 수 있어야 하므로 aria-disabled만 쓰고 클릭은 허용한다.
              const locationGated = o.key === "distance" && !p.hasPosition;
              return (
                <button key={o.key} type="button" role="radio" aria-checked={selected}
                  aria-disabled={!a.enabled && !locationGated ? true : undefined}
                  disabled={!a.enabled && !locationGated}
                  className={`cf-sort ${selected ? "on" : ""}`}
                  onClick={() => p.onChangeSort(o.key)}>
                  <span className="cf-sort-label">{o.label}</span>
                  {!a.enabled && a.reason && <span className="cf-sort-reason">{a.reason}</span>}
                  {selected && <UiIcon name="check" size={18} />}
                </button>
              );
            })}
          </div>
        </section>

        <div className="cf-actions">
          <button type="button" className="ghost-btn" onClick={p.onReset}>초기화</button>
          <button type="button" className="primary-btn" onClick={p.onClose} aria-label={`적용, 결과 ${p.resultCount}곳`}>적용</button>
        </div>
      </div>
    </SheetOverlay>
  );
}
