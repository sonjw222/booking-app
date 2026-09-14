/*
  하단 Navigation에서 "예약"/"내 예약" 탭을 보여줄지 판단하는 계정 전체 스코프의
  수강권 보유 여부 체크. usable_memberships()(reservation_functions.sql)는 특정 수업
  기준(class_allowed_products/membership_schedule_rules 포함)이라 이 용도로 재사용할 수
  없다 — 여기서는 센터/수업과 무관하게 "예약에 쓸 수 있는 수강권이 하나라도 있는지"만
  본다(memberships RLS "매니저 수강권 조회" 정책이 profile_id in my_profile_ids()를
  이미 허용하므로 새 RPC/RLS 없이 클라이언트에서 직접 조회 가능).
*/
import { supabase } from "./supabaseClient";
import { getMyAccountId } from "./authAccount";

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

// BottomNav는 페이지마다 새로 마운트되는 컴포넌트라(공용 layout이 아님, 이 앱은 클라이언트
// 라우팅이 없어 탭 전환마다 전체 페이지가 서버에서부터 다시 렌더링된다 — app/layout.tsx
// 주석 참고) 판정 전 기본값을 null로 두면 수강권이 있는 사용자는 탭을 옮길 때마다
// "3탭 → 5탭"으로 깜빡인다. localStorage는 서버가 읽을 수 없어 서버 렌더링(=최초 페인트)
// 자체는 못 바꾸므로, 쿠키에 직전 판정 결과를 저장해둔다 — 다음 전체 페이지 로드 때
// app/layout.tsx(서버 컴포넌트)가 이 쿠키를 읽어 GlobalBottomNav의 최초 렌더링 값으로
// 내려주면, 최초 1회(쿠키가 없을 때)를 제외하고는 깜빡임 없이 바로 맞는 탭 구성으로
// 그려진다. 실제 자격 판정은 여전히 서버(RLS)/클라이언트 재확인이 하고, 이 쿠키는 그
// 결과가 나오기 전까지 뭘 먼저 그릴지 정하는 힌트일 뿐이다.
const HAS_USABLE_COOKIE_KEY = "nav_has_usable_membership";

export function setCachedHasUsableMembership(v: boolean): void {
  try {
    document.cookie = `${HAS_USABLE_COOKIE_KEY}=${v ? "1" : "0"}; path=/; max-age=${60 * 60 * 24 * 30}; SameSite=Lax`;
  } catch { /* 무시 */ }
}

// app/layout.tsx(서버 컴포넌트)가 next/headers의 cookies()로 읽은 원시 문자열을 넘겨주면
// 판정한다 — 이 파일은 클라이언트 컴포넌트에서도 import되므로 next/headers는 여기서
// 직접 import하지 않는다(서버 전용 모듈이라 클라이언트 번들에 섞이면 안 됨).
export function parseHasUsableMembershipCookie(raw: string | undefined): boolean | null {
  if (raw === "1") return true;
  if (raw === "0") return false;
  return null;
}

export async function fetchHasUsableMembership(): Promise<boolean> {
  const accountId = await getMyAccountId();
  if (!accountId) return false;

  const { data: profiles, error: profErr } = await supabase
    .from("profiles").select("id").eq("account_id", accountId).is("deleted_at", null);
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
