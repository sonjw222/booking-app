import type { HistoryItem } from "./mypage";

const STATUS_LABEL: Record<string, string> = {
  confirmed: "예약 확정",
  waitlisted: "대기",
  cancelled: "취소",
  completed: "완료",
  no_show: "노쇼",
  attended: "출석",
};

// startAt(classes.start_time, timestamptz 원본 ISO)로만 미래/과거를 판정한다 — when은
// KST 표시용으로 포맷된 문자열이라 비교에 쓰면 안 된다. 파싱 실패/결측(연결된 수업이
// 삭제된 경우 등)은 판정 불가 상태로 null 반환 — 예정/지난 어느 쪽에도 강제로 넣지 않는다.
export function startAtMs(h: Pick<HistoryItem, "startAt">): number | null {
  if (!h.startAt) return null;
  const t = new Date(h.startAt).getTime();
  return Number.isNaN(t) ? null : t;
}

// 지난 예약이지만 아직 최종 상태(출석/노쇼/취소)가 기록되지 않은 경우(여전히 confirmed나
// waitlisted) — 새 상태를 만들지 않고 배지를 아예 안 보여준다.
const FINAL_PAST_STATUSES = new Set(["attended", "no_show", "cancelled"]);

// 정책(2026-09-14 릴리스 폴리시 배치, 2026-09-14 사용자 피드백으로 취소 건 규칙 수정) —
// 예정된 예약: startAt > now && 상태가 confirmed/waitlisted. 지난 예약: startAt <= now면
// 상태 무관하게 무조건 지난 예약 + "취소된 예약은 수업 시작 전/후 상관없이 항상 지난
// 예약"(사용자 명시 지시 — 미래 시간의 취소 건이 "전체"에만 보이고 예정/지난 어디에도
// 없는 게 애매하다는 피드백) — 즉 isPast는 "시각이 지났거나 OR 상태가 cancelled"로
// 판정한다. 지난 예약에서는 "예약 확정"/"대기"/취소 버튼을 절대 렌더링하지 않는다 —
// 최종 상태(출석/노쇼/취소)가 있으면 그것만 배지로 보여주고, 없으면(아직 출석 처리
// 전 등) 새 상태를 만들지 않고 배지 없이 비워둔다. 이 함수 하나를 필터링과 카드 렌더링
// 양쪽에서 재사용해 두 곳의 판정이 어긋나지 않게 한다 — 순수 함수라 단위 테스트로
// 경계값(startAt==now, 미래 취소 포함)을 직접 검증할 수 있다.
export function classifyReservationDisplay(
  h: Pick<HistoryItem, "startAt" | "status">,
  now: number
): { isPast: boolean; badgeLabel: string | null; cancellable: boolean } {
  const t = startAtMs(h);
  const timeIsPast = t !== null && t <= now;
  const isPast = timeIsPast || h.status === "cancelled";
  const badgeLabel = isPast
    ? (FINAL_PAST_STATUSES.has(h.status) ? STATUS_LABEL[h.status] : null)
    : (STATUS_LABEL[h.status] ?? h.status);
  const cancellable = !isPast && (h.status === "confirmed" || h.status === "waitlisted");
  return { isPast, badgeLabel, cancellable };
}

