/* 공개 수업 상세에서 "지금 이 사람이 이 수업으로 무엇을 할 수 있는가"를 정한다(UX-02·03·04).
   - 수업 정보(공개)와 예약 가능 여부(회원 상태)는 별개다 — 수강권이 없다는 이유로 상세를 막지 않고, 상태에 맞는 다음 행동만 바꾼다.
   - 사용 가능 여부의 기준은 서버 RPC usable_memberships_for_classes(예약 시점의 usable_memberships/reserve_with_membership와 같은 판정)다.
     이 파일은 그 결과를 읽어 안내를 고를 뿐 판정을 다시 구현하지 않는다. 최종 판정은 예약 시점에 서버가 다시 한다.
   - 읽기 전용. 결제·예약·환불·권한을 바꾸지 않는다. */
import { supabase } from "./supabaseClient";
import { getMyAccountId } from "./authAccount";
import { fetchMyProfiles, fetchUsableMembershipsByClass, type BookingProfile, type UsableMembership } from "./reservations";
import { todayKstYmd } from "./membershipExpiry";

export type PassStatus = "usable" | "mismatch" | "expired_or_used" | "none";
export type ProfileViewerState = { profile: BookingProfile; usable: UsableMembership[]; status: PassStatus };
export type ViewerState =
  | { kind: "anon" }
  | { kind: "member"; profiles: ProfileViewerState[] }
  | { kind: "error" };

export type CenterMembershipFact = { profile_id: string; status: string; remaining_count: number | null; expires_at: string | null; kind: "pass" | "goods" };

/** 서버가 usable로 돌려준 수가 0일 때, 왜 못 쓰는지(조건 불일치 vs 만료·소진 vs 수강권 없음)를 센터 수강권 현황으로 구분한다. */
export function classifyPassStatus(usableCount: number, memberships: Pick<CenterMembershipFact, "status" | "remaining_count" | "expires_at" | "kind">[], today: string): PassStatus {
  if (usableCount > 0) return "usable";
  const passes = memberships.filter((m) => m.kind !== "goods" && m.status !== "refunded");
  if (passes.length === 0) return "none";
  const stillValid = passes.some((m) => m.status === "active" && (m.remaining_count == null || m.remaining_count > 0) && (!m.expires_at || m.expires_at >= today));
  return stillValid ? "mismatch" : "expired_or_used";
}

export type ClassAction =
  | { kind: "closed" }                       // 취소·지난·마감 수업 — 예약 버튼 비활성
  | { kind: "login" }                        // 비로그인 → 로그인하고 같은 수업으로 복귀
  | { kind: "reserve" }                      // 이 프로필로 바로 예약 단계
  | { kind: "blocked"; reason: Exclude<PassStatus, "usable"> }
  | { kind: "check_at_reserve" };            // 수강권 현황을 못 읽음 — 막지 않고 예약 단계(서버 판정)로 보낸다

export function decideClassAction(bookability: "open" | "closed" | "cancelled" | "past", viewer: ViewerState | null, profileId: string | null): ClassAction {
  if (bookability !== "open") return { kind: "closed" };
  if (!viewer || viewer.kind === "error") return { kind: "check_at_reserve" };
  if (viewer.kind === "anon") return { kind: "login" };
  const cur = viewer.profiles.find((p) => p.profile.id === profileId) ?? viewer.profiles[0];
  if (!cur) return { kind: "blocked", reason: "none" };
  return cur.status === "usable" ? { kind: "reserve" } : { kind: "blocked", reason: cur.status };
}

export const BLOCKED_COPY: Record<Exclude<PassStatus, "usable">, { title: string; description: string }> = {
  none: { title: "이 수업은 수강권이 필요해요", description: "이 센터의 수강권이 있어야 예약할 수 있어요. 사용할 수 있는 수강권을 확인해 보세요." },
  mismatch: { title: "보유한 수강권을 이 수업에 쓸 수 없어요", description: "수강권의 사용 조건(수업·요일·시간)이 이 수업과 맞지 않아요. 이 수업에 쓸 수 있는 수강권을 확인해 보세요." },
  expired_or_used: { title: "사용할 수 있는 수강권이 없어요", description: "보유한 수강권이 만료됐거나 횟수를 모두 사용했어요. 이 수업에 쓸 수 있는 수강권을 확인해 보세요." },
};

/** 로그인 회원의 프로필별 사용 가능 수강권. 조회 실패는 error(막지 않고 예약 단계의 서버 판정에 맡긴다). 비로그인은 anon. */
export async function fetchViewerClassState(centerId: string, classId: string): Promise<ViewerState> {
  try {
    // 로그인 여부는 로컬 세션으로 먼저 본다(네트워크 없음) — 비로그인은 오류가 아니라 정상 상태다.
    const { data: sessionData } = await supabase.auth.getSession();
    if (!sessionData.session) return { kind: "anon" };
    const accountId = await getMyAccountId();
    if (!accountId) return { kind: "error" };
    const profiles = await fetchMyProfiles(accountId);
    if (profiles.length === 0) return { kind: "error" };
    const { data, error } = await supabase
      .from("memberships")
      .select("profile_id, status, remaining_count, expires_at, products(product_kind)")
      .in("profile_id", profiles.map((p) => p.id)).eq("center_id", centerId);
    if (error) return { kind: "error" };
    const facts: CenterMembershipFact[] = ((data ?? []) as unknown as { profile_id: string; status: string; remaining_count: number | null; expires_at: string | null; products: { product_kind?: string } | { product_kind?: string }[] | null }[])
      .map((m) => {
        const prod = Array.isArray(m.products) ? m.products[0] : m.products;
        return { profile_id: m.profile_id, status: m.status, remaining_count: m.remaining_count, expires_at: m.expires_at, kind: prod?.product_kind === "goods" ? "goods" : "pass" };
      });
    const today = todayKstYmd();
    const rows: ProfileViewerState[] = [];
    for (const profile of profiles) {
      const usable = (await fetchUsableMembershipsByClass([classId], profile.id))[classId] ?? [];
      rows.push({ profile, usable, status: classifyPassStatus(usable.length, facts, today) });
    }
    return { kind: "member", profiles: rows };
  } catch { return { kind: "error" }; }
}
