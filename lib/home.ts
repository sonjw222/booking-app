/*
  홈 화면 데이터
  - 승인된 센터 목록 (제휴 센터 스크롤용)
  - 앞으로 예약 가능한 수업 몇 개 (지금 예약 가능한 클래스)
  로그인 없이도 볼 수 있어야 하므로 공개 조회만 사용
*/

import { supabase } from "./supabaseClient";

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
    latitude: c.latitude, longitude: c.longitude, distanceKm: null,
  }));

  // 내 위치가 있으면 거리 계산 후 가까운 순 정렬 (좌표 있는 센터 우선)
  if (userLat != null && userLng != null) {
    const toRad = (d: number) => (d * Math.PI) / 180;
    for (const c of centers) {
      if (c.latitude != null && c.longitude != null) {
        const dLat = toRad(c.latitude - userLat);
        const dLng = toRad(c.longitude - userLng);
        const a = Math.sin(dLat / 2) ** 2 +
          Math.cos(toRad(userLat)) * Math.cos(toRad(c.latitude)) * Math.sin(dLng / 2) ** 2;
        c.distanceKm = 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      }
    }
    centers.sort((a, b) => {
      if (a.distanceKm == null && b.distanceKm == null) return 0;
      if (a.distanceKm == null) return 1;
      if (b.distanceKm == null) return -1;
      return a.distanceKm - b.distanceKm;
    });
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

  // 승인된 센터 전부 가져와서 클라이언트에서 매칭 (규모 작을 때 충분)
  const { data, error } = await supabase
    .from("centers")
    .select("id, name, categories, intro, photo_url")
    .eq("status", "approved");
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
  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) return [];   // 비로그인 → 빈 목록 (일반 추천으로 대체)

  const { data: acc } = await supabase.from("accounts").select("id").eq("auth_id", authData.user.id).single();
  if (!acc) return [];
  const { data: profs } = await supabase.from("profiles").select("id").eq("account_id", acc.id);
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
