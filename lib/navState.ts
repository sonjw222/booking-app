/*
  하단 Navigation에서 "예약"/"내 예약" 탭을 보여줄지 판단하는 계정 전체 스코프의
  수강권 보유 여부 체크. usable_memberships()(reservation_functions.sql)는 특정 수업
  기준(class_allowed_products/membership_schedule_rules 포함)이라 이 용도로 재사용할 수
  없다 — 여기서는 센터/수업과 무관하게 "예약에 쓸 수 있는 수강권이 하나라도 있는지"만
  본다(memberships RLS "매니저 수강권 조회" 정책이 profile_id in my_profile_ids()를
  이미 허용하므로 새 RPC/RLS 없이 클라이언트에서 직접 조회 가능).
*/
import { supabase } from "./supabaseClient";

// query가 이미 status='active' && expires_at>=today로 필터링한 뒤 남는 판단은
// remaining_count뿐이다 — null(무제한권)이거나 1 이상이면 예약에 쓸 수 있다.
// 이 순수 predicate만 따로 export해 단위 테스트로 검증한다(NAV-001).
export function isUsableMembershipRow(m: { remaining_count: number | null }): boolean {
  return m.remaining_count == null || m.remaining_count > 0;
}

// 하단 Nav의 "예약"/"내 예약" 탭을 보여줄지 판단. null(판정 전/로딩 중)은 false와 동일하게
// 취급한다 — "있다"고 가정한 뒤 나중에 틀렸을 때 탭이 사라지는 깜빡임을 막기 위함이다.
export function shouldShowMembershipTabs(hasUsable: boolean | null): boolean {
  return hasUsable === true;
}

export async function fetchHasUsableMembership(): Promise<boolean> {
  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) return false;

  const { data: acc, error: accErr } = await supabase
    .from("accounts").select("id").eq("auth_id", authData.user.id).single();
  if (accErr || !acc) return false;

  const { data: profiles, error: profErr } = await supabase
    .from("profiles").select("id").eq("account_id", (acc as any).id);
  if (profErr) throw new Error("프로필을 확인하지 못했어요: " + profErr.message);
  const profileIds = (profiles ?? []).map((p: any) => p.id);
  if (profileIds.length === 0) return false;

  const today = new Date().toISOString().slice(0, 10);
  const { data: mems, error: memErr } = await supabase
    .from("memberships")
    .select("id, remaining_count")
    .in("profile_id", profileIds)
    .eq("status", "active")
    .gte("expires_at", today);
  if (memErr) throw new Error("수강권을 확인하지 못했어요: " + memErr.message);

  return (mems ?? []).some((m: any) => isUsableMembershipRow(m));
}
