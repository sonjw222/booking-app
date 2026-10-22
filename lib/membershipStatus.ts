/* 수강권/상품의 "횟수 종류"와 "이용 상태"를 한 곳에서 판정한다(감사 F15·F17). 마이·구매 내역·관리자 화면이 같은 기준을 쓴다. 순수 함수(네트워크·DOM 없음).
   - 횟수 무제한은 상품 종류별 플래그다: 수강권(pass)은 unlimited_pass, 대여 상품(goods)은 unlimited. 예전 마이 화면은 상품용 unlimited 만 읽어
     unlimited_pass=true 인 수강권이 "회 / 회 남음"으로 비어 보였다. 일반 횟수권의 비정상 NULL(횟수 정보 없음)은 무제한이 아니라 "확인 필요"다.
   - 이용 상태는 저장된 status 만이 아니라 만료일·잔여 횟수·시작일을 함께 본다. 결제 상태(주문 paid/done)와 수강권 이용 상태는 별개다.
   - 이 판정은 표시용이다. 실제 예약 가능 여부(만료·소진·수업 조건)는 항상 서버(usable_memberships / reserve_with_membership)가 판정하며 여기서 권한을 넓히지 않는다. */
export type CountKind = "unlimited" | "limited" | "unknown";
export type CountInput = { productKind: "pass" | "goods" | string | null | undefined; unlimitedPass?: boolean | null; unlimitedGoods?: boolean | null; totalCount: number | null | undefined; remainingCount: number | null | undefined };

export function countKind(i: CountInput): CountKind {
  const unlimited = i.productKind === "goods" ? !!i.unlimitedGoods : !!i.unlimitedPass;
  if (unlimited) return "unlimited";
  if (typeof i.remainingCount === "number" && typeof i.totalCount === "number" && i.totalCount >= 0) return "limited";
  return "unknown";
}

/** "무제한" / "3회 / 5회 남음" / "횟수 정보 없음". NULL 산술(NaN·"null회")이 화면에 나오지 않게 한다. */
export function remainingText(i: CountInput): string {
  const kind = countKind(i);
  if (kind === "unlimited") return "무제한";
  if (kind === "limited") return `${i.remainingCount}회 / ${i.totalCount}회 남음`;
  return "횟수 정보 없음";
}

/** 진행률(0~100). 횟수 종류가 아니면 null(막대를 그리지 않는다). */
export function remainingPercent(i: CountInput): number | null {
  if (countKind(i) !== "limited" || !i.totalCount || i.totalCount <= 0) return null;
  return Math.max(0, Math.min(100, ((i.remainingCount as number) / i.totalCount) * 100));
}

export type UsageState = "refunded" | "transferred" | "expired" | "exhausted" | "upcoming" | "paused" | "active";
export const USAGE_LABEL: Record<UsageState, string> = {
  active: "이용중", upcoming: "이용 예정", paused: "정지", exhausted: "소진", expired: "만료", refunded: "환불됨", transferred: "양도됨",
};

/** KST 기준 날짜 문자열(YYYY-MM-DD)끼리 비교한다. 만료일 당일까지는 이용 가능(서버: expires_at >= current_date). */
export function usageState(i: CountInput & { status: string | null | undefined; expiresAt: string | null | undefined; startsAt?: string | null }, todayKst: string): UsageState {
  if (i.status === "refunded") return "refunded";
  if (i.status === "transferred") return "transferred";
  const unlimited = countKind(i) === "unlimited";
  if (i.expiresAt && i.expiresAt < todayKst) return "expired";
  if (!unlimited && typeof i.remainingCount === "number" && i.remainingCount <= 0) return "exhausted";
  if (i.startsAt && i.startsAt > todayKst) return "upcoming";
  if (i.status === "paused") return "paused";
  if (i.status === "expired") return "expired";   // 저장 상태가 만료인데 날짜로는 판정이 안 되는 경우(수동 만료 처리 등)
  return "active";
}
