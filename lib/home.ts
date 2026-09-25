/*
  홈 화면 데이터
  - 승인된 센터 목록 (제휴 센터 스크롤용)
  - 앞으로 예약 가능한 수업 몇 개 (지금 예약 가능한 클래스)
  로그인 없이도 볼 수 있어야 하므로 공개 조회만 사용
*/

import { supabase } from "./supabaseClient";
import { getMyAccountId } from "./authAccount";

// QA Fix Batch(2026-09-18) — "내 주변 센터" 반경(km). 감사 결과 이 앱에는 센터별/회원별로
// 설정 가능한 검색 반경 컬럼이나 화면이 없다(center_settings, app 설정 어디에도 없음 —
// Business Scenario E2E Phase 3에서 이미 확인됨). 그래서 제품에 적합한 기본값을 여기
// 한 곳에만 정의한다 — 값을 바꾸고 싶으면 이 상수 하나만 바꾸면 된다(매직넘버를 여러
// 파일에 흩어놓지 않기 위함). 한국 대도시권에서 "차로 이동 가능한 생활권" 수준인 20km를
// 기본값으로 선택했다(서울 강남↔종로 정도 거리) — 나중에 회원/센터가 반경을 직접 고를 수
// 있는 UI가 생기면 이 값을 기본 선택값으로 재사용하면 된다.
//
// (병렬 폴리시 배치 8차가 별도 worktree에서 같은 기능을 먼저 최소 구현했다가, 병합 시
// 이 QA Fix Batch 버전으로 통일했다 — 반경 필터/좌표 검증 로직은 이 파일 기준이 최종.
// haversineKm()만 그쪽 단위테스트(tests/unit/home.nearbyRadius.test.ts)와의 호환을 위해
// 순수 함수로 유지한다.)
export const NEARBY_RADIUS_KM = 20;

// 순수 함수로 분리 — 단위 테스트(경계값 등)에서 네트워크/Supabase 목 없이 바로 검증할 수
// 있게 fetchHomeCenters() 밖으로 뺐다.
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

function isValidCoordinate(lat: unknown, lng: unknown): boolean {
  return (
    typeof lat === "number" && Number.isFinite(lat) && lat >= -90 && lat <= 90 &&
    typeof lng === "number" && Number.isFinite(lng) && lng >= -180 && lng <= 180
  );
}

export type HomeClass = {
  id: string;
  title: string;
  centerId: string;
  centerName: string;
  startText: string;   // "7/23 (수) 19:30"
  reserved: number;
  capacity: number;
};

export type NextReservation = {
  title: string;
  centerName: string;
  startText: string;
  status: "confirmed" | "waitlisted";
};

// 홈은 전체 예약 이력 대신 앞으로의 첫 예약 한 건만 읽는다.
export async function fetchNextReservation(): Promise<NextReservation | null> {
  const accountId = await getMyAccountId();
  if (!accountId) return null;
  const { data: profiles, error: profileError } = await supabase
    .from("profiles").select("id").eq("account_id", accountId).is("deleted_at", null);
  if (profileError) throw profileError;
  const ids = (profiles ?? []).map((profile) => profile.id);
  if (ids.length === 0) return null;

  const { data, error } = await supabase
    .from("classes")
    .select("title, start_time, centers(name), reservations!inner(profile_id, status)")
    .in("reservations.profile_id", ids)
    .in("reservations.status", ["confirmed", "waitlisted"])
    .gte("start_time", new Date().toISOString())
    .order("start_time", { ascending: true })
    .limit(1);
  if (error) throw error;
  const cls = data?.[0] as unknown as {
    title: string; start_time: string; centers?: { name: string };
    reservations?: { status: "confirmed" | "waitlisted" }[];
  } | undefined;
  return cls && cls.reservations?.[0] ? {
    title: cls.title, centerName: cls.centers?.name ?? "",
    startText: KST_DT.format(new Date(cls.start_time)), status: cls.reservations[0].status,
  } : null;
}

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

  // 내 위치가 유효하면(잘못된 좌표는 무시 — 권한 거부/획득 실패 시 그냥 undefined로
  // 넘어오므로 이 분기 자체를 안 탐, 여기서 거르는 건 "숫자이긴 한데 범위를 벗어난"
  // 방어적인 경우) 거리 계산 → 반경(NEARBY_RADIUS_KM) 밖은 제외 → 가까운 순 정렬한다.
  // QA Fix Batch(2026-09-18) 이전에는 반경 컷오프가 없어 "내 주변"을 눌러도 전국 센터가
  // 그냥 거리순으로만 나열됐다 — 이제 실제로 반경 밖 센터는 결과에서 빠진다.
  if (isValidCoordinate(userLat, userLng)) {
    for (const c of centers) {
      if (isValidCoordinate(c.latitude, c.longitude)) {
        c.distanceKm = haversineKm(userLat!, userLng!, c.latitude!, c.longitude!);
      }
      // 좌표가 없거나 유효하지 않은 센터는 distanceKm이 null로 남는다 — "내 주변"
      // 기능 성격상 거리를 확신할 수 없으면 안전하게 제외한다(아래 filter).
    }
    centers = centers.filter((c) => c.distanceKm != null && c.distanceKm <= NEARBY_RADIUS_KM);
    centers.sort((a, b) => (a.distanceKm as number) - (b.distanceKm as number));
  }
  // 위치가 없으면(권한 거부/미획득) 기존 fallback — 반경 필터 없이 최신 승인순 그대로
  // 반환한다(요청 원문 "위치 권한 없음 → 기존 fallback UX 유지").
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

export type SearchClass = {
  id: string;
  title: string;
  centerName: string;
  startText: string;
  date: string;
  centerId: string;
};

// 검색에서는 시작 전인 공개 수업만 최대 20개 보여주고, 전체 일정은 예약 화면에서 본다.
export async function searchClasses(keyword: string): Promise<SearchClass[]> {
  const kw = keyword.trim();
  if (kw.length < 2) return [];
  const { data, error } = await supabase.from("classes")
    .select("id, title, center_id, start_time, centers!inner(name, status)")
    .eq("centers.status", "approved")
    .ilike("title", `%${kw}%`)
    .gte("start_time", new Date().toISOString())
    .order("start_time", { ascending: true })
    .limit(20);
  if (error) throw new Error("수업 검색에 실패했어요: " + error.message);
  const dateFormatter = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" });
  return (data ?? []).map((row) => {
    const start = new Date(row.start_time);
    const dateParts = dateFormatter.formatToParts(start);
    const part = (type: string) => dateParts.find((item) => item.type === type)?.value ?? "";
    return {
      id: row.id, title: row.title, centerId: row.center_id,
      centerName: (row.centers as unknown as { name: string }).name,
      startText: KST_DT.format(start), date: `${part("year")}-${part("month")}-${part("day")}`,
    };
  });
}

// 센터명 또는 종목으로 검색
export async function searchHome(keyword: string): Promise<{ centers: SearchCenter[]; categories: string[] }> {
  const kw = keyword.trim();
  if (!kw) return { centers: [], categories: [] };

  // 스토어 스크린샷 QA(2026-09-23) — 승인 센터가 500개를 넘어가면서 위 "전부 읽어와
  // 클라이언트에서 매칭"이 뒤 순번 센터를 검색에서 통째로 누락시켰다(이름을 정확히
  // 입력해도 500번째 밖이면 후보에 아예 없었음 — fetchCentersByCategory는 서버 필터라
  // 이 문제가 없어 "종목 탐색으로는 들어가지는데 검색만 안 된다"는 증상으로 나타남).
  // 이름/종목 매칭을 각각 서버(DB) 쿼리로 옮겨 상한 없이 정확하게 찾는다 — 대량 egress
  // 방지 원칙은 그대로 유지: 전체 목록을 읽지 않고 매칭된 결과만 받아온다.
  //
  // 종목 매칭은 배열 컬럼(categories)의 "부분일치"를 PostgREST 필터 하나로 표현할 수
  // 없어서(예: "피겨" 검색이 "피겨스케이팅" 라벨을 찾아야 함), 먼저 service_categories에서
  // 라벨 자체가 키워드를 포함하는 종목을 구한 뒤(이 테이블은 작아 상한 문제 없음),
  // 그 라벨 전체 목록과 categories 배열이 하나라도 겹치는지(overlaps)를 서버에서
  // 필터링한다 — 기존 클라이언트 매칭과 동일한 결과를 내면서 서버 쪽에서 실행된다.
  const { data: cats, error: catLabelError } = await supabase.from("service_categories").select("label");
  if (catLabelError) throw new Error("검색에 실패했어요: " + catLabelError.message);
  const categories = (cats ?? [])
    .map((c: any) => c.label)
    .filter((label: string) => label.includes(kw));

  const nameQuery = supabase
    .from("centers")
    .select("id, name, categories, intro, photo_url")
    .eq("status", "approved")
    .ilike("name", `%${kw}%`);
  const categoryQuery = categories.length > 0
    ? supabase
        .from("centers")
        .select("id, name, categories, intro, photo_url")
        .eq("status", "approved")
        .overlaps("categories", categories)
    : null;

  const [nameResult, categoryResult] = await Promise.all([
    nameQuery,
    categoryQuery ?? Promise.resolve({ data: [] as any[], error: null }),
  ]);
  if (nameResult.error) throw new Error("검색에 실패했어요: " + nameResult.error.message);
  if (categoryResult.error) throw new Error("검색에 실패했어요: " + categoryResult.error.message);

  // 이름/종목 두 쿼리 모두에 걸리는 센터가 있을 수 있어(예: 센터명에 종목이 들어간
  // 경우) id 기준으로 중복 제거.
  const merged = new Map<string, SearchCenter>();
  for (const c of [...(nameResult.data ?? []), ...(categoryResult.data ?? [])] as any[]) {
    if (!merged.has(c.id)) {
      merged.set(c.id, {
        id: c.id, name: c.name, categories: c.categories ?? [],
        intro: c.intro, photoUrl: c.photo_url,
      });
    }
  }

  return { centers: Array.from(merged.values()), categories };
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
