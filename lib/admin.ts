/*
  플랫폼 운영자 - 센터 승인 관리
  - 승인대기(pending) 센터 목록 조회
  - 승인(approved) / 반려(rejected) 처리
  - is_platform_admin = true 인 계정만 접근 가능
*/

import { supabase } from "./supabaseClient";

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
  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) return false;
  const { data } = await supabase
    .from("accounts")
    .select("is_platform_admin")
    .eq("auth_id", authData.user.id)
    .single();
  return data?.is_platform_admin ?? false;
}

// 센터 목록 (상태별)
export async function fetchCenters(status: "pending" | "approved" | "rejected"): Promise<PendingCenter[]> {
  const { data, error } = await supabase
    .from("centers")
    .select(`
      id, name, address, phone, business_number, business_license_url,
      status, reject_reason, created_at,
      manager_centers(accounts(name, phone))
    `)
    .eq("status", status)
    .order("created_at", { ascending: false });

  if (error) throw new Error("센터 목록을 불러오지 못했어요: " + error.message);

  return (data ?? []).map((c: any) => {
    // 이 센터의 첫 매니저(= 개설한 오너)를 대표자로 표시
    const owner = c.manager_centers?.[0]?.accounts ?? null;
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
      ownerName: owner?.name ?? null,
      ownerPhone: owner?.phone ?? null,
    };
  });
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
