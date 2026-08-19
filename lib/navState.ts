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

// BottomNav는 페이지마다 새로 마운트되는 컴포넌트라(공용 layout이 아님) 판정 전 기본값을
// null로 두면 수강권이 있는 사용자는 페이지를 옮길 때마다 "탭 3개 → 5개"로 깜빡인다.
// 직전에 확인한 결과를 기기에 캐싱해두고 다음 마운트의 초기값으로 써서, 최초 1회(또는
// 캐시가 없을 때)를 제외하면 깜빡임 없이 바로 맞는 탭 구성으로 그려지게 한다.
const HAS_USABLE_CACHE_KEY = "nav_has_usable_membership";

export function getCachedHasUsableMembership(): boolean | null {
  try {
    const v = localStorage.getItem(HAS_USABLE_CACHE_KEY);
    if (v === "1") return true;
    if (v === "0") return false;
  } catch { /* 무시 */ }
  return null;
}

export function setCachedHasUsableMembership(v: boolean): void {
  try { localStorage.setItem(HAS_USABLE_CACHE_KEY, v ? "1" : "0"); } catch { /* 무시 */ }
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
