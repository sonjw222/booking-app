/*
  상품 공개범위 "지정 회원" 칩 라벨 조회 (PERF-043).
  기존에는 상품 수정 시트를 열 때 fetchMembers(centerId) 전체(회원 최대 2000명 + 프로필/수강권/전화 RPC)를
  불러온 뒤 선택된 id만 걸러 썼다. 선택된 center_members.id만 조회해 같은 라벨(이름 + 전화)을 만든다.
  - 전화번호는 fetchMembers와 동일하게 fetch_member_phones_safe RPC(서버 권한 검사/마스킹)로만 받는다.
  - center_id 필터를 유지해 다른 센터 회원은 라벨에 섞이지 않는다.
*/
import { displayMemberName } from "./memberName";
import { supabase } from "./supabaseClient";

export async function fetchVisibilityMemberLabels(centerId: string, centerMemberIds: string[]): Promise<Record<string, string>> {
  if (centerMemberIds.length === 0) return {};
  const { data, error } = await supabase
    .from("center_members")
    .select("id, profile_id, profiles(name)")
    .eq("center_id", centerId)
    .in("id", centerMemberIds);
  if (error) throw new Error("회원 정보를 불러오지 못했어요: " + error.message);
  const rows = (data ?? []) as any[];
  const profileIds = rows.map((r) => r.profile_id);
  const phoneByProfile: Record<string, string | null> = {};
  if (profileIds.length > 0) {
    const { data: phones } = await supabase.rpc("fetch_member_phones_safe", {
      p_profile_ids: profileIds, p_center_id: centerId,
    });
    for (const row of (phones ?? []) as any[]) phoneByProfile[row.profile_id] = row.account_phone ?? null;
  }
  const labels: Record<string, string> = {};
  for (const r of rows) {
    const phone = phoneByProfile[r.profile_id] ?? null;
    labels[r.id] = `${displayMemberName(r.profiles?.name)}${phone ? " " + phone : ""}`;
  }
  return labels;
}
