/*
  NICEPAY 심사관의 "탐색" 범위 — 홈·검색·종목·문의 센터 검색에서 심사 센터만 보이게 한다.
  서버(RLS)는 심사관이 매니저인 센터(예: 기존 Toss 심사 센터)를 "관리 화면용"으로 계속 읽게 둔다(기존 매니저 권한 유지, 관리 화면은 manager_centers 로 센터를 읽는다).
  그래서 일반 회원용 탐색 쿼리에서만 앱이 `is_nicepay_review = true` 를 추가한다. 심사관이 아니면(대부분) 쿼리는 그대로다.
  구매·예약·상품 목록(RPC)·주문은 서버가 별도로 막는다(nicepay_review_center_member_allowed).
*/
import { fetchMyNicepayReviewAccess } from "./authAccount";

/** true 이면 탐색 쿼리에 심사 센터만 남긴다. 조회 실패는 false(기존 동작). */
export async function nicepayDiscoveryOnlyReviewCenters(): Promise<boolean> {
  try { return await fetchMyNicepayReviewAccess(); } catch { return false; }
}
