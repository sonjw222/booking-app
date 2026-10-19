/* 검색 결과 화면의 필터 적용과 "결과 없음" 원인 구분(UX-08).
   예전에는 '오늘 수업'·'내 주변' 필터 때문에 0건이어도 "더 짧은 이름이나 다른 종목으로 검색해보세요"만 보였다(오늘 필터를 풀면 16건이 돌아오는데도).
   이제 검색어 자체의 결과 없음 / 오늘 필터 / 주변 필터 / 둘 다를 구분해, 실제 제약을 푸는 행동을 안내한다. 순수 함수(네트워크·DOM 없음). */
export type Scope = "all" | "classes" | "centers";
type ClassLike = { date: string; latitude: number | null; longitude: number | null };
type CenterLike = { latitude: number | null; longitude: number | null };
export type Position = { lat: number; lng: number };

export type SearchEmpty = "none" | "no_match" | "today_filter" | "near_filter" | "both_filters";

export function computeSearchView<C extends ClassLike, K extends CenterLike>(i: {
  classes: C[]; centers: K[]; categories: string[]; scope: Scope; todayOnly: boolean; nearOnly: boolean; today: string;
  position: Position | null; radiusKm: number; distanceKm: (aLat: number, aLng: number, bLat: number, bLng: number) => number;
}): { classes: C[]; centers: K[]; empty: SearchEmpty } {
  const near = (lat: number | null, lng: number | null, on: boolean) =>
    !on || !i.position || (lat != null && lng != null && i.distanceKm(i.position.lat, i.position.lng, lat, lng) <= i.radiusKm);
  const pick = (todayOn: boolean, nearOn: boolean) => ({
    classes: i.classes.filter((c) => (!todayOn || c.date === i.today) && near(c.latitude, c.longitude, nearOn)),
    centers: i.centers.filter((c) => near(c.latitude, c.longitude, nearOn)),
  });
  const visible = (r: { classes: unknown[]; centers: unknown[] }) =>
    (i.scope !== "centers" ? r.classes.length : 0) + (i.scope !== "classes" ? r.centers.length : 0) + (i.scope === "all" ? i.categories.length : 0);
  const now = pick(i.todayOnly, i.nearOnly);
  if (visible(now) > 0) return { ...now, empty: "none" };
  if (!i.todayOnly && !i.nearOnly) return { ...now, empty: "no_match" };
  const withoutToday = i.todayOnly ? visible(pick(false, i.nearOnly)) : 0;
  const withoutNear = i.nearOnly ? visible(pick(i.todayOnly, false)) : 0;
  const withoutBoth = visible(pick(false, false));
  if (withoutBoth === 0) return { ...now, empty: "no_match" };
  if (withoutToday > 0 && i.todayOnly) return { ...now, empty: "today_filter" };
  if (withoutNear > 0 && i.nearOnly) return { ...now, empty: "near_filter" };
  return { ...now, empty: "both_filters" };
}

export const SEARCH_EMPTY_COPY: Record<Exclude<SearchEmpty, "none">, { title: string; description: string }> = {
  no_match: { title: "검색 결과가 없어요", description: "더 짧은 이름이나 다른 종목으로 검색해보세요." },
  today_filter: { title: "오늘 예정된 수업이 없어요", description: "'오늘 수업' 조건을 해제하면 다른 날짜의 수업을 볼 수 있어요." },
  near_filter: { title: "내 주변에는 결과가 없어요", description: "'내 주변' 조건을 해제하면 다른 지역의 결과를 볼 수 있어요." },
  both_filters: { title: "조건에 맞는 결과가 없어요", description: "'오늘 수업'과 '내 주변' 조건을 함께 해제하면 결과가 나타나요." },
};
