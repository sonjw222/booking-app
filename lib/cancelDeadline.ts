/*
  RES-001 C-5(예약 후 10분 이내 무료 취소 예외)의 실제 취소 가능 시각 계산을, DB 함수
  cancel_reservation()의 로직과 정확히 동일하게 클라이언트에서도 재현할 수 있도록 뽑아낸
  순수 함수. 지금 당장 UI에 표시용으로 쓰이진 않지만(이번 배치는 버그 수정 범위로 한정),
  "취소 가능 시각 계산"을 서버 SQL 밖에서도 검증 가능한 형태로 남겨 향후 카운트다운 등
  UI에 재사용하거나, SQL 쪽 로직 변경 시 이 파일의 테스트로 회귀를 잡기 위함이다.

  공식(cancel_reservation() SQL과 동일):
    grace  = min(createdAt + 10분, classStartTime)
    effective = max(centerCancelDeadline, grace)
    isLate = now > effective
  단, 수업 시작 이후는 이 계산과 무관하게 항상 취소 불가(서버 쪽 별도 선행 체크와 동일).
*/

const GRACE_PERIOD_MS = 10 * 60 * 1000;

export function computeEffectiveCancelDeadline(
  centerCancelDeadline: Date,
  createdAt: Date,
  classStartTime: Date
): Date {
  const grace = Math.min(createdAt.getTime() + GRACE_PERIOD_MS, classStartTime.getTime());
  const effective = Math.max(centerCancelDeadline.getTime(), grace);
  return new Date(effective);
}

export function isCancellable(
  now: Date,
  centerCancelDeadline: Date,
  createdAt: Date,
  classStartTime: Date
): boolean {
  if (now.getTime() >= classStartTime.getTime()) return false; // 수업 시작 이후는 무조건 불가
  const effective = computeEffectiveCancelDeadline(centerCancelDeadline, createdAt, classStartTime);
  return now.getTime() <= effective.getTime();
}
