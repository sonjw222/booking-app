/*
  종목별 센터 목록의 필터·정렬 상태 모델 (순수 함수 — 네트워크/브라우저 의존 없음)
  - 종목(category)은 라우트가 정하고, 이 모델은 검색어 · 거리 범위 · 정렬만 다룬다. 세 값은 URL 쿼리로 직렬화되어
    새로고침/뒤로가기/공유 링크에서도 그대로 복원된다(parseDiscoveryParams ↔ serializeDiscoveryParams).
  - 거리·평점은 실제 데이터(센터 좌표, center_reviews)로만 계산한다. 값이 없으면 숨기거나 정렬 끝으로 보낸다(임의 점수 금지).
*/
import { haversineKm } from "./home";

export const DISTANCE_OPTIONS = [null, 1, 3, 5, 10, 20] as const;
export type RadiusKm = (typeof DISTANCE_OPTIONS)[number];
export type SortKey = "recommended" | "distance" | "rating" | "name";
export const SORT_OPTIONS: readonly { key: SortKey; label: string }[] = [
  { key: "recommended", label: "추천순" },
  { key: "distance", label: "거리순" },
  { key: "rating", label: "평점 높은 순" },
  { key: "name", label: "이름순" },
];

export type DiscoveryState = { query: string; radiusKm: RadiusKm; sort: SortKey };
export const DEFAULT_DISCOVERY: DiscoveryState = { query: "", radiusKm: null, sort: "recommended" };

export type Position = { lat: number; lng: number };
export type CenterRating = { average: number; count: number };
export type DiscoverableCenter = {
  id: string; name: string; address?: string | null; intro?: string | null;
  latitude: number | null; longitude: number | null;
};
export type DiscoveryRow<T extends DiscoverableCenter> = { center: T; distanceKm: number | null; rating: CenterRating | null };

export function radiusLabel(r: RadiusKm): string { return r == null ? "전체" : `${r}km`; }
export function sortLabel(s: SortKey): string { return SORT_OPTIONS.find((o) => o.key === s)?.label ?? "추천순"; }

function validCoordinate(lat: unknown, lng: unknown): boolean {
  return typeof lat === "number" && Number.isFinite(lat) && lat >= -90 && lat <= 90
    && typeof lng === "number" && Number.isFinite(lng) && lng >= -180 && lng <= 180;
}

export function distanceKmTo(position: Position | null, c: { latitude: number | null; longitude: number | null }): number | null {
  if (!position || !validCoordinate(position.lat, position.lng) || !validCoordinate(c.latitude, c.longitude)) return null;
  return haversineKm(position.lat, position.lng, c.latitude as number, c.longitude as number);
}

export function formatDistance(km: number): string {
  if (km < 1) return `${Math.max(10, Math.round(km * 100) * 10)}m`;
  return `${km < 10 ? km.toFixed(1) : Math.round(km)}km`;
}

/* ---- URL 직렬화: 기본값은 쿼리에서 생략한다 ---- */
export function parseDiscoveryParams(params: { get(name: string): string | null }): DiscoveryState {
  const rawRadius = Number(params.get("r"));
  const radiusKm = (DISTANCE_OPTIONS as readonly (number | null)[]).includes(rawRadius) && rawRadius > 0 ? (rawRadius as RadiusKm) : null;
  const rawSort = params.get("s");
  const sort = SORT_OPTIONS.some((o) => o.key === rawSort) ? (rawSort as SortKey) : "recommended";
  return { query: (params.get("q") ?? "").slice(0, 100), radiusKm, sort };
}

export function serializeDiscoveryParams(state: DiscoveryState): string {
  const p = new URLSearchParams();
  if (state.query.trim()) p.set("q", state.query.trim());
  if (state.radiusKm != null) p.set("r", String(state.radiusKm));
  if (state.sort !== "recommended") p.set("s", state.sort);
  return p.toString();
}

export function activeFilterCount(state: DiscoveryState): number {
  return (state.radiusKm != null ? 1 : 0) + (state.sort !== "recommended" ? 1 : 0) + (state.query.trim() ? 1 : 0);
}

/* ---- 정렬/필터 가능 여부 (비활성 사유를 UI에 그대로 보여준다) ---- */
export type OptionAvailability = { enabled: boolean; reason: string | null };

export function sortAvailability(
  key: SortKey,
  ctx: { hasPosition: boolean; ratingsLoaded: boolean; anyRated: boolean },
): OptionAvailability {
  if (key === "distance" && !ctx.hasPosition) return { enabled: false, reason: "내 위치를 허용하면 선택할 수 있어요" };
  if (key === "rating") {
    if (!ctx.ratingsLoaded) return { enabled: false, reason: "평점 정보를 불러오지 못했어요" };
    if (!ctx.anyRated) return { enabled: false, reason: "아직 등록된 평점이 없어요" };
  }
  return { enabled: true, reason: null };
}

const norm = (s: string) => s.normalize("NFC").toLowerCase().replace(/\s+/g, "");

export function matchesQuery(c: DiscoverableCenter, query: string): boolean {
  const q = norm(query.trim());
  if (!q) return true;
  return [c.name, c.address ?? "", c.intro ?? ""].some((field) => norm(field).includes(q));
}

export type DiscoveryResult<T extends DiscoverableCenter> = {
  rows: DiscoveryRow<T>[];
  /** 거리 범위가 켜져 있어 좌표가 없어서(거리를 확인할 수 없어) 제외된 센터 수 */
  excludedNoDistance: number;
  /** 거리 범위/거리순을 요청했지만 위치를 모르는 상태 — 이때 거리 조건은 적용하지 않는다(전체를 보여주고 안내) */
  locationNeeded: boolean;
};

export function applyDiscovery<T extends DiscoverableCenter>(
  centers: readonly T[],
  state: DiscoveryState,
  position: Position | null,
  ratings: Readonly<Record<string, CenterRating>>,
): DiscoveryResult<T> {
  const hasPosition = !!position && validCoordinate(position.lat, position.lng);
  const wantsDistance = state.radiusKm != null || state.sort === "distance";
  const locationNeeded = wantsDistance && !hasPosition;

  let rows: DiscoveryRow<T>[] = centers
    .filter((c) => matchesQuery(c, state.query))
    .map((center) => ({ center, distanceKm: distanceKmTo(position, center), rating: ratings[center.id] ?? null }));

  let excludedNoDistance = 0;
  if (state.radiusKm != null && hasPosition) {
    const radius = state.radiusKm;
    rows = rows.filter((r) => {
      if (r.distanceKm == null) { excludedNoDistance++; return false; }
      return r.distanceKm <= radius;
    });
  }

  const byName = (a: DiscoveryRow<T>, b: DiscoveryRow<T>) => a.center.name.localeCompare(b.center.name, "ko");
  const index = new Map(centers.map((c, i) => [c.id, i]));
  const original = (a: DiscoveryRow<T>, b: DiscoveryRow<T>) => (index.get(a.center.id) ?? 0) - (index.get(b.center.id) ?? 0);
  if (state.sort === "name") rows = [...rows].sort((a, b) => byName(a, b) || original(a, b));
  else if (state.sort === "distance" && hasPosition) {
    rows = [...rows].sort((a, b) => {
      if (a.distanceKm == null && b.distanceKm == null) return byName(a, b) || original(a, b);
      if (a.distanceKm == null) return 1;
      if (b.distanceKm == null) return -1;
      return a.distanceKm - b.distanceKm || byName(a, b);
    });
  } else if (state.sort === "rating") {
    rows = [...rows].sort((a, b) => {
      if (!a.rating && !b.rating) return original(a, b);   // 평점 없는 센터끼리는 추천순 유지
      if (!a.rating) return 1;
      if (!b.rating) return -1;
      return b.rating.average - a.rating.average || b.rating.count - a.rating.count || byName(a, b);
    });
  }
  // recommended(또는 위치 없이 distance 요청): 서버가 준 기본 순서 그대로
  return { rows, excludedNoDistance, locationNeeded };
}

/** center_reviews 행(센터 id, 별점) → 센터별 평균/건수. 1~5 범위를 벗어난 값은 무시한다. */
export function aggregateRatings(rows: readonly { center_id: string; rating: number }[]): Record<string, CenterRating> {
  const sums: Record<string, { sum: number; count: number }> = {};
  for (const r of rows) {
    if (typeof r.rating !== "number" || !(r.rating >= 1 && r.rating <= 5)) continue;
    const s = (sums[r.center_id] ??= { sum: 0, count: 0 });
    s.sum += r.rating; s.count += 1;
  }
  const out: Record<string, CenterRating> = {};
  for (const [id, s] of Object.entries(sums)) out[id] = { average: Math.round((s.sum / s.count) * 10) / 10, count: s.count };
  return out;
}

/** 주소 한 줄 요약: "서울 강남구 테헤란로 1" → "서울 강남구" (앞 두 단어). 주소가 없으면 null. */
export function summarizeAddress(address: string | null | undefined): string | null {
  const parts = (address ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  return parts.slice(0, 2).join(" ");
}
