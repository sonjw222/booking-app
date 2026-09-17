/*
  홈 화면 데이터
  - 승인된 센터 목록 (제휴 센터 스크롤용)
  - 앞으로 예약 가능한 수업 몇 개 (지금 예약 가능한 클래스)
  로그인 없이도 볼 수 있어야 하므로 공개 조회만 사용
*/

import { supabase } from "./supabaseClient";
import { getMyAccountId } from "./authAccount";

// 릴리스 폴리시 배치 8차(2026-09-17/18) — "내 주변" 반경 필터. 감사 결과: 기존
// fetchHomeCenters()는 위치가 있으면 "정렬"만 했지 실제로 반경 밖 센터를 제외하지는
// 않았다(제주 사용자에게도 서울/부산 센터가 그냥 "멀리 있는 순서"로 계속 표시될 수 있었음
// — 추가 시나리오 섹션이 지적한 문제). 병렬로 진행 중인 다른 세션(Business Logic Fix
// Batch)이 이 위치 반경 로직을 더 정교하게 다룰 수도 있어(예약 당일예약/정원 invariant와
// 같은 배치) 이 worktree에는 반영돼 있지 않다 — 이 worktree 기준으로는 미구현이 맞아서
// 최소 구현을 추가한다. 값 자체(20km)는 도심형 센터 검색 UX 기준 임의값이라, 다른
// 세션의 구현이 병합되면 이 상수/필터는 그쪽 값으로 대체/정리돼야 한다(최종 보고 참고).
export const NEARBY_RADIUS_KM = 20;

// 순수 함수로 분리 — 단위 테스트(경계값 등)에서 네트워크/Supabase 목 없이 바로 검증하려고
// fetchHomeCenters() 밖으로 뺐다.
export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export type HomeCenter = {
  id: string;
  name: string;
  categories: string[];
  latitude: number | null;
  longitude: number | null;
  distanceKm: number | null;
};

export type HomeClass = {
  id: string;
  title: string;
  centerId: string;
  centerName: string;
  startText: string;   // "7/23 (수) 19:30"
  reserved: number;
  capacity: number;
};

const KST_DT = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul",
  month: "numeric", day: "numeric", weekday: "short",
  hour: "2-digit", minute: "2-digit", hour12: false,
});

// 승인된 센터
export async function fetchHomeCenters(userLat?: number, userLng?: number): Promise<HomeCenter[]> {
  const { data, error } = await supabase
    .from("centers")
    .select("id, name, categories, latitude, longitude")
    .eq("status", "approved")
    .order("created_at", { ascending: false })
    .limit(30);
  if (error) throw new Error("센터를 불러오지 못했어요: " + error.message);

  let centers: HomeCenter[] = (data ?? []).map((c: any) => ({
    id: c.id, name: c.name, categories: c.categories ?? [],
    // 좌표 값이 숫자가 아니면(잘못된 데이터, 문자열 "NaN" 등) 그 센터만 "좌표 없음"으로
    // 안전하게 처리한다 — 목록 전체가 죽으면 안 된다(추가 시나리오 9번).
    latitude: Number.isFinite(c.latitude) ? c.latitude : null,
    longitude: Number.isFinite(c.longitude) ? c.longitude : null,
    distanceKm: null,
  }));

  // 내 위치가 있으면 거리 계산 → 반경(NEARBY_RADIUS_KM) 밖은 제외 → 가까운 순 정렬.
  // 위치가 없으면(권한 거부/조회 실패) 기존과 동일하게 반경 필터 없이 최신순 그대로 —
  // 위치 실패가 홈 화면 전체를 비우거나 죽이면 안 된다(추가 시나리오 6/7).
  if (userLat != null && userLng != null && Number.isFinite(userLat) && Number.isFinite(userLng)) {
    for (const c of centers) {
      if (c.latitude != null && c.longitude != null) {
        c.distanceKm = haversineKm(userLat, userLng, c.latitude, c.longitude);
      }
    }
    centers = centers.filter((c) => c.distanceKm != null && c.distanceKm <= NEARBY_RADIUS_KM);
    centers.sort((a, b) => (a.distanceKm as number) - (b.distanceKm as number));
  }
  return centers.slice(0, 10);
}

// 지금 이후 예약 가능한 수업 (가까운 순 몇 개)
export async function fetchHomeClasses(): Promise<HomeClass[]> {
  const nowIso = new Date().toISOString();
  const { data, error } = await supabase
    .from("classes")
    .select("id, title, center_id, start_time, capacity, centers!inner(name, status)")
    .eq("status", "open")
    .eq("centers.status", "approved")
    .gte("start_time", nowIso)
    .order("start_time", { ascending: true })
    .limit(8);
  if (error) throw new Error("수업을 불러오지 못했어요: " + error.message);

  const rows = data ?? [];
  const ids = rows.map((r: any) => r.id);

  // 예약 인원
  const counts: Record<string, number> = {};
  if (ids.length > 0) {
    const { data: cnt } = await supabase
      .from("class_reservation_counts")
      .select("class_id, confirmed_count")
      .in("class_id", ids);
    for (const c of cnt ?? []) counts[(c as any).class_id] = (c as any).confirmed_count;
  }

  return rows.map((r: any) => ({
    id: r.id,
    title: r.title,
    centerId: r.center_id,
    centerName: r.centers?.name ?? "",
    startText: KST_DT.format(new Date(r.start_time)),
    reserved: counts[r.id] ?? 0,
    capacity: r.capacity,
  }));
}

/* ============================================================
   검색 + 종목별 센터 목록
   ============================================================ */

export type SearchCenter = {
  id: string;
  name: string;
  categories: string[];
  intro: string | null;
  photoUrl: string | null;
};

// 센터명 또는 종목으로 검색
export async function searchHome(keyword: string): Promise<{ centers: SearchCenter[]; categories: string[] }> {
  const kw = keyword.trim();
  if (!kw) return { centers: [], categories: [] };

  // 승인된 센터 전부 가져와서 클라이언트에서 매칭 (규모 작을 때 충분) — categories가
  // 배열 컬럼이라 "종목 부분일치"까지 한 번에 서버 필터링하기 어려워 클라이언트 매칭
  // 구조는 유지하되, 승인 센터 전체가 계속 불어나는 상황에 대비해 상한만 추가한다
  // (egress 감사, 2026-09-15 — 지금 규모에선 동작 그대로).
  const { data, error } = await supabase
    .from("centers")
    .select("id, name, categories, intro, photo_url")
    .eq("status", "approved")
    .limit(500);
  if (error) throw new Error("검색에 실패했어요: " + error.message);

  const centers: SearchCenter[] = (data ?? [])
    .filter((c: any) =>
      c.name?.includes(kw) ||
      (c.categories ?? []).some((cat: string) => cat.includes(kw))
    )
    .map((c: any) => ({
      id: c.id, name: c.name, categories: c.categories ?? [],
      intro: c.intro, photoUrl: c.photo_url,
    }));

  // 매칭되는 종목 (예: "피겨" → "피겨스케이팅")
  const { data: cats } = await supabase.from("service_categories").select("label");
  const categories = (cats ?? [])
    .map((c: any) => c.label)
    .filter((label: string) => label.includes(kw));

  return { centers, categories };
}

// 특정 종목의 센터 목록
export async function fetchCentersByCategory(category: string): Promise<SearchCenter[]> {
  const { data, error } = await supabase
    .from("centers")
    .select("id, name, categories, intro, photo_url")
    .eq("status", "approved")
    .contains("categories", [category]);
  if (error) throw new Error("센터를 불러오지 못했어요: " + error.message);
  return (data ?? []).map((c: any) => ({
    id: c.id, name: c.name, categories: c.categories ?? [],
    intro: c.intro, photoUrl: c.photo_url,
  }));
}

/* ============================================================
   지금 예약 가능 - 일주일 내 내 수강권으로 예약 가능한 수업
   ============================================================ */

export async function fetchMyUpcomingClasses(): Promise<HomeClass[]> {
  const accountId = await getMyAccountId();
  if (!accountId) return [];   // 비로그인 → 빈 목록 (일반 추천으로 대체)

  const { data: profs } = await supabase.from("profiles").select("id").eq("account_id", accountId).is("deleted_at", null);
  const profileIds = (profs ?? []).map((p: any) => p.id);
  if (profileIds.length === 0) return [];

  // 내가 활성 수강권(pass) 보유한 센터
  const today = new Date().toISOString().slice(0, 10);
  const { data: mems } = await supabase
    .from("memberships")
    .select("center_id, remaining_count, expires_at, status, products(product_kind)")
    .in("profile_id", profileIds)
    .eq("status", "active");
  const passCenters = new Set<string>();
  for (const m of mems ?? []) {
    const ok = (m as any).products?.product_kind !== "goods"
      && ((m as any).remaining_count == null || (m as any).remaining_count > 0)
      && (!(m as any).expires_at || (m as any).expires_at >= today);
    if (ok) passCenters.add((m as any).center_id);
  }
  if (passCenters.size === 0) return [];

  // 앞으로 7일 이내, 그 센터들의 수업
  const now = new Date();
  const weekLater = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const { data, error } = await supabase
    .from("classes")
    .select("id, title, center_id, start_time, capacity, centers!inner(name, status)")
    .eq("status", "open")
    .eq("centers.status", "approved")
    .in("center_id", Array.from(passCenters))
    .gte("start_time", now.toISOString())
    .lte("start_time", weekLater.toISOString())
    .order("start_time", { ascending: true })
    .limit(10);
  if (error) throw new Error("수업을 불러오지 못했어요: " + error.message);

  const rows = data ?? [];
  const ids = rows.map((r: any) => r.id);
  const counts: Record<string, number> = {};
  if (ids.length > 0) {
    const { data: cnt } = await supabase
      .from("class_reservation_counts").select("class_id, confirmed_count").in("class_id", ids);
    for (const c of cnt ?? []) counts[(c as any).class_id] = (c as any).confirmed_count;
  }

  return rows.map((r: any) => ({
    id: r.id,
    title: r.title,
    centerId: r.center_id,
    centerName: r.centers?.name ?? "",
    startText: KST_DT.format(new Date(r.start_time)),
    reserved: counts[r.id] ?? 0,
    capacity: r.capacity,
  }));
}
