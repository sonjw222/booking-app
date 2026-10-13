/*
  플랫폼 운영자 - 센터 승인 관리
  - 승인대기(pending) 센터 목록 조회
  - 승인(approved) / 반려(rejected) 처리
  - is_platform_admin = true 인 계정만 접근 가능
*/

import { supabase } from "./supabaseClient";
import { centerMatchesKeyword } from "./adminCenterSearch";
import { getMyAccountId } from "./authAccount";

export type PendingCenter = {
  id: string;
  name: string;
  address: string | null;
  phone: string | null;
  businessNumber: string | null;
  businessLicenseUrl: string | null;
  status: "pending" | "approved" | "rejected";
  rejectReason: string | null;
  createdAt: string;
  ownerName: string | null;
  ownerPhone: string | null;
};

const KST = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul",
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hour12: false,
});

// 지금 로그인한 계정이 플랫폼 운영자인지 확인
export async function checkPlatformAdmin(): Promise<boolean> {
  const accountId = await getMyAccountId();
  if (!accountId) return false;
  const { data } = await supabase
    .from("accounts")
    .select("is_platform_admin")
    .eq("id", accountId)
    .single();
  return data?.is_platform_admin ?? false;
}

// RPC admin_list_centers(add_admin_list_centers_rpc_20261009.sql)가 돌려주는 행 — 서버가 플랫폼 관리자 자격을 확인한다.
type AdminCenterRow = {
  id: string; name: string; address: string | null; phone: string | null;
  business_number: string | null; business_license_url: string | null;
  status: PendingCenter["status"]; reject_reason: string | null; created_at: string;
  owner_name: string | null; owner_phone: string | null;
};

// 센터 목록 (상태별) — business_number/business_license_url/reject_reason은 centers 테이블 직접 SELECT가 막혀 있어
// (fix_centers_sensitive_column_privileges_20261009.sql) 관리자 전용 RPC로만 읽는다.
export async function fetchCenters(status: "pending" | "approved" | "rejected"): Promise<PendingCenter[]> {
  const { data, error } = await supabase.rpc("admin_list_centers", { p_status: status });

  if (error) throw new Error("센터 목록을 불러오지 못했어요: " + error.message);

  return ((data ?? []) as AdminCenterRow[]).map(mapCenter);
}

function mapCenter(c: AdminCenterRow): PendingCenter {
  return {
    id: c.id,
    name: c.name,
    address: c.address,
    phone: c.phone,
    businessNumber: c.business_number,
    businessLicenseUrl: c.business_license_url,
    status: c.status,
    rejectReason: c.reject_reason,
    createdAt: KST.format(new Date(c.created_at)),
    // 이 센터의 첫 매니저(= 개설한 오너)를 대표자로 표시
    ownerName: c.owner_name ?? null,
    ownerPhone: c.owner_phone ?? null,
  };
}


export type CenterCursor = { createdAt: string; id: string };
export type CenterPage = { centers: PendingCenter[]; nextCursor: CenterCursor | null };
// Default off: the additive RPC needs separate SQL approval before enabling this build-time flag.
export async function fetchCenterPage(status: PendingCenter["status"], keyword = "", cursor: CenterCursor | null = null): Promise<CenterPage> {
  const server = process.env.NEXT_PUBLIC_ADMIN_CENTER_PAGINATION === "true";
  const { data, error } = await supabase.rpc(server ? "admin_list_centers_page" : "admin_list_centers", server ? {
    p_status: status, p_keyword: keyword, p_limit: 30,
    p_before_created_at: cursor?.createdAt ?? null, p_before_id: cursor?.id ?? null,
  } : { p_status: status });
  if (error) throw new Error("센터 목록을 불러오지 못했어요: " + error.message);
  let rows = (data ?? []) as AdminCenterRow[];
  if (!server) {
    rows = rows.filter(c => centerMatchesKeyword(mapCenter(c), keyword))
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id.localeCompare(a.id))
      .filter(c => !cursor || Date.parse(c.created_at) < Date.parse(cursor.createdAt) || (Date.parse(c.created_at) === Date.parse(cursor.createdAt) && c.id < cursor.id));
  }
  const page = rows.slice(0, 30);
  const last = page[page.length - 1];
  return { centers: page.map(mapCenter), nextCursor: rows.length > 30 && last ? { createdAt: last.created_at, id: last.id } : null };
}

// 승인
export async function approveCenter(centerId: string): Promise<void> {
  const { error } = await supabase
    .from("centers")
    .update({ status: "approved", reject_reason: null })
    .eq("id", centerId);
  if (error) throw new Error("승인 처리에 실패했어요: " + error.message);
}

// 반려 (사유 필수)
export async function rejectCenter(centerId: string, reason: string): Promise<void> {
  const { error } = await supabase
    .from("centers")
    .update({ status: "rejected", reject_reason: reason })
    .eq("id", centerId);
  if (error) throw new Error("반려 처리에 실패했어요: " + error.message);
}

// 반려된 센터를 다시 대기로 되돌리기 (재심사)
export async function resetToPending(centerId: string): Promise<void> {
  const { error } = await supabase
    .from("centers")
    .update({ status: "pending", reject_reason: null })
    .eq("id", centerId);
  if (error) throw new Error("처리에 실패했어요: " + error.message);
}
