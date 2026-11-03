/*
  NICEPAY 심사관의 "탐색" 범위 — 홈·검색·종목·문의 센터 검색에서 (심사 센터 + 관리자가 허용 목록에 넣은 실제 센터)만 보이게 한다.
  서버(RLS)는 심사관이 매니저인 센터(예: 기존 Toss 심사 센터)를 "관리 화면용"으로 계속 읽게 둔다(기존 매니저 권한 유지, 관리 화면은 manager_centers 로 센터를 읽는다).
  그래서 일반 회원용 탐색 쿼리에서만 앱이 심사 범위를 추가한다. 심사관이 아니면(대부분) null → 쿼리는 그대로다.
  허용 센터 id 는 앱 코드에 두지 않고 DB(nicepay_review_center_grants)에서 RPC(nicepay_my_review_center_ids)로 읽는다 — add_nicepay_review_real_center_grants_20261103.sql 적용 전에는
  RPC 가 없으므로 빈 목록으로 처리해 기존 동작(심사 센터만)과 같다.
  구매·예약·상품 목록(RPC)·주문은 서버가 별도로 막는다(nicepay_review_center_member_allowed / _purchase_allowed).
*/
import { supabase } from "./supabaseClient";
import { fetchMyNicepayReviewAccess } from "./authAccount";

export type ReviewScope = { extraCenterIds: string[] };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 심사관이면 탐색 범위(허용 센터 id 포함), 아니면 null(기존 동작). 조회 실패는 null/빈 목록으로 안전하게 처리한다. */
export async function nicepayDiscoveryScope(): Promise<ReviewScope | null> {
  let reviewer = false;
  try { reviewer = await fetchMyNicepayReviewAccess(); } catch { return null; }
  if (!reviewer) return null;
  try {
    const { data, error } = await supabase.rpc("nicepay_my_review_center_ids");
    if (error || !Array.isArray(data)) return { extraCenterIds: [] };
    const ids = (data as Array<{ center_id?: unknown }>).map((r) => r.center_id).filter((v): v is string => typeof v === "string" && UUID.test(v));
    return { extraCenterIds: [...new Set(ids)] };
  } catch { return { extraCenterIds: [] }; }
}

/** @deprecated 호환용 — 심사관 여부만 필요할 때. 새 코드는 nicepayDiscoveryScope() 를 쓴다. */
export async function nicepayDiscoveryOnlyReviewCenters(): Promise<boolean> {
  return (await nicepayDiscoveryScope()) !== null;
}

interface Narrowable<Q> {
  eq(column: string, value: unknown): Q;
  or(filters: string, options?: { referencedTable?: string }): Q;
}
/**
 * 심사 범위로 좁힌다: 허용 센터가 없으면 `is_nicepay_review = true`(기존과 동일), 있으면 `(심사 센터 OR id ∈ 허용 센터)`.
 * referencedTable 은 `classes … centers!inner(...)` 처럼 센터가 임베드된 쿼리일 때 "centers".
 */
export function narrowToReviewCenters<Q extends Narrowable<Q>>(q: Q, scope: ReviewScope, referencedTable?: string): Q {
  if (scope.extraCenterIds.length === 0) return q.eq(referencedTable ? `${referencedTable}.is_nicepay_review` : "is_nicepay_review", true);
  const filter = `is_nicepay_review.eq.true,id.in.(${scope.extraCenterIds.join(",")})`;
  return referencedTable ? q.or(filter, { referencedTable }) : q.or(filter);
}
