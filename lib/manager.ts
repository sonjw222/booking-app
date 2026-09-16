/*
  매니저 대시보드 데이터 함수
  - 내가 운영하는 센터 목록
  - 선택한 센터의 오늘 수업 + 예약 현황
*/

import { supabase } from "./supabaseClient";
import { getMyAccountId as getMyAccountIdBase } from "./authAccount";

export type ManagedCenter = {
  id: string;
  name: string;
  roleName: string;  // 예: "스튜디오 오너", "매니저", "강사"
  isOwner: boolean;
  status: string;    // manager_centers.status: pending / active / suspended (이 소속 자체의 상태)
  // centers.status: pending / approved / rejected — 플랫폼 운영자가 센터를 승인했는지.
  // pending이면 회원 화면(lib/center.ts fetchCenterDetail 등)엔 전혀 안 보이는데, 매니저는
  // 소속만 active면 수업/수강권/스태프를 다 세팅할 수 있어 이 사실을 모르고 지나치기 쉬움
  // (2026-09-06 UX 감사) — 매니저 화면에 승인 대기 배너를 띄우는 데 사용.
  approvalStatus: string;
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
  const accountId = await getMyAccountIdBase();
  if (!accountId) throw new Error("계정 정보를 찾을 수 없어요");
  // ACL-005: 매니저 여부는 accounts.is_manager(스태프 초대 시 RLS로 인해 갱신되지
  // 않을 수 있는 별도 플래그)가 아니라, 실제 active manager_centers 소속 존재
  // 여부로 판단한다. 관리자 진입 조건 ≠ 메뉴별 권한 보유 여부 — 권한이 0개인
  // 스태프도 소속만 active면 관리자 모드에는 들어올 수 있어야 한다.
  const { count, error: mcError } = await supabase
    .from("manager_centers")
    .select("id", { count: "exact", head: true })
    .eq("account_id", accountId)
    .eq("status", "active");
  if (mcError) throw new Error("매니저 권한을 확인하지 못했어요: " + mcError.message);
  if (!count) throw new Error("매니저 권한이 없는 계정이에요");
  return accountId;
}

// egress 감사(2026-09-15) — 이 앱은 클라이언트 라우팅이 없어(lib/navState.ts 주석 참고)
// 매니저 탭 전환마다 전체 페이지가 새로 로드되는데, 그 한 번의 페이지 로드 안에서도
// ManagerNav + PendingApprovalBanner + 각 /manager/* 페이지 자신이 각자 마운트 시점에
// fetchMyCenters()를 독립적으로 호출해(3곳 × getMyAccountId 확인 쿼리 1개 + 목록 조회
// 쿼리 1개 = 최대 6개 요청) 같은 "내가 운영하는 센터 목록"을 페이지 로드 1회당 최대 3번
// 중복 조회하고 있었다. 이 세 호출은 같은 렌더 커밋에서 마운트되는 useEffect들이라
// 실제 네트워크 요청이 시작되기 전(첫 await 전)에 이미 다 걸려온다 — in-flight 중인
// 프라미스만 공유하고 완료되면 바로 비운다(다음 페이지 로드 때까지 결과를 들고
// 있지 않음) — 그래서 이후에 별도로 다시 부르는 호출은 항상 최신 데이터를 받는다.
let myCentersRequest: Promise<ManagedCenter[]> | null = null;

// 내가 운영/근무하는 센터 목록
export async function fetchMyCenters(): Promise<ManagedCenter[]> {
  if (myCentersRequest) return myCentersRequest;
  myCentersRequest = (async () => {
    const accountId = await getMyAccountId();
    const { data, error } = await supabase
      .from("manager_centers")
      .select("id, role_id, status, centers(id, name, status), center_roles(name, is_owner)")
      .eq("account_id", accountId)
      .eq("status", "active"); // 소속 자체는 활성인 것만 (센터 승인 여부와는 별개)
    if (error) throw new Error("센터 목록을 불러오지 못했어요: " + error.message);
    return (data ?? [])
      .filter((r: any) => r.centers)
      .map((r: any) => ({
        id: r.centers.id,
        name: r.centers.name,
        roleName: r.center_roles?.name ?? "매니저",
        isOwner: r.center_roles?.is_owner ?? false,
        status: r.status,
        approvalStatus: r.centers.status ?? "approved",
        managerCenterId: r.id,
        roleId: r.role_id ?? null,
      }));
  })();
  // 성공하든 실패하든 완료 즉시 비운다 — 동시에 마운트된 호출끼리만 공유하고, 그 뒤에
  // 별도로 들어오는 호출(예: 다른 화면 흐름에서 다시 부르는 경우)은 항상 새로 조회한다.
  myCentersRequest.finally(() => { myCentersRequest = null; }).catch(() => {});
  return myCentersRequest;
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
