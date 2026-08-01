/*
  매니저 대시보드 데이터 함수
  - 내가 운영하는 센터 목록
  - 선택한 센터의 오늘 수업 + 예약 현황
*/

import { supabase } from "./supabaseClient";

export type ManagedCenter = {
  id: string;
  name: string;
  roleName: string;  // 예: "스튜디오 오너", "매니저", "강사"
  isOwner: boolean;
  status: string;    // pending / active / suspended
  managerCenterId: string; // manager_centers.id (권한 조회용)
  roleId: string | null;   // center_roles.id (권한 조회용)
};

export type TodayClass = {
  id: string;
  title: string;
  start: string;
  end: string;
  reserved: number;
  capacity: number;
};

const KST_TIME = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hour12: false });
const KST_DATE = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" });

async function getMyAccountId(): Promise<string> {
  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) throw new Error("로그인이 필요해요");
  const { data, error } = await supabase
    .from("accounts").select("id, is_manager").eq("auth_id", authData.user.id).single();
  if (error || !data) throw new Error("계정 정보를 찾을 수 없어요");
  if (!data.is_manager) throw new Error("매니저 권한이 없는 계정이에요");
  return data.id;
}

// 내가 운영/근무하는 센터 목록
export async function fetchMyCenters(): Promise<ManagedCenter[]> {
  const accountId = await getMyAccountId();
  const { data, error } = await supabase
    .from("manager_centers")
    .select("id, role_id, status, centers(id, name), center_roles(name, is_owner)")
    .eq("account_id", accountId)
    .eq("status", "active"); // 승인된(활성) 센터만
  if (error) throw new Error("센터 목록을 불러오지 못했어요: " + error.message);
  return (data ?? [])
    .filter((r: any) => r.centers)
    .map((r: any) => ({
      id: r.centers.id,
      name: r.centers.name,
      roleName: r.center_roles?.name ?? "매니저",
      isOwner: r.center_roles?.is_owner ?? false,
      status: r.status,
      managerCenterId: r.id,
      roleId: r.role_id ?? null,
    }));
}

// ACL-003: URL 파라미터로 넘어온 centerId에 대해 "내가 이 센터의 오너인지" 확인.
//   목록에 그 센터가 아예 없으면(다른 센터 스태프가 URL을 조작한 경우 포함) false.
export function isOwnerOfCenter(centers: ManagedCenter[], centerId: string | null): boolean {
  if (!centerId) return false;
  const c = centers.find((x) => x.id === centerId);
  return c?.isOwner ?? false;
}

// 특정 센터의 오늘(KST) 수업 + 예약 인원
export async function fetchTodayClasses(centerId: string): Promise<TodayClass[]> {
  const todayKst = KST_DATE.format(new Date()); // "2026-07-14"
  const start = `${todayKst}T00:00:00+09:00`;
  const end = `${todayKst}T23:59:59+09:00`;

  const { data: classRows, error } = await supabase
    .from("classes")
    .select("id, title, start_time, end_time, capacity")
    .eq("center_id", centerId)
    .gte("start_time", start)
    .lte("start_time", end)
    .order("start_time");
  if (error) throw new Error("수업을 불러오지 못했어요: " + error.message);

  const ids = (classRows ?? []).map((c) => c.id);
  const counts: Record<string, number> = {};
  if (ids.length > 0) {
    const { data: countRows } = await supabase
      .from("class_reservation_counts")
      .select("class_id, confirmed_count")
      .in("class_id", ids);
    for (const r of countRows ?? []) counts[r.class_id] = r.confirmed_count;
  }

  return (classRows ?? []).map((c) => ({
    id: c.id,
    title: c.title,
    start: KST_TIME.format(new Date(c.start_time)),
    end: KST_TIME.format(new Date(c.end_time)),
    reserved: counts[c.id] ?? 0,
    capacity: c.capacity,
  }));
}
