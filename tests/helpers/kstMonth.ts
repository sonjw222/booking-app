/*
  통합 테스트용 KST(Asia/Seoul) 월 계산 헬퍼 — 테스트 전용(앱 코드 아님).
  앱은 회원 화면의 "그 달"을 KST 기준으로 조회한다(lib/kst.ts getKstMonthUtcRange). 테스트가 러너 로컬 시간대
  (CI = UTC)의 Date.getMonth()/getFullYear() 로 대상 월을 계산하면, 수업 시작이 UTC 월말·KST 다음 달 초에 걸릴 때
  (예: 2026-12-31T18:00Z = 2027-01-01 03:00 KST) 월이 어긋나 수업이 조회되지 않는다(Issue #277).
  이 파일은 머신 시간대를 전혀 쓰지 않는다: KST 는 UTC+9(서머타임 없음)이므로 +9h 로 옮긴 뒤 getUTC* 만 읽거나,
  "+09:00" 오프셋을 명시한 ISO 문자열을 Date 로 파싱한다. 현재 시각은 now 인자로 주입할 수 있어 결정적으로 검증된다.
*/
const KST_OFFSET_MS = 9 * 3600 * 1000;

/** 주어진 순간의 KST 달력상 연/월(month 는 1~12). */
export function kstYearMonth(at: Date): { year: number; month: number } {
  const k = new Date(at.getTime() + KST_OFFSET_MS);
  return { year: k.getUTCFullYear(), month: k.getUTCMonth() + 1 };
}

/**
 * now(KST 달력 기준) 로부터 monthsAhead 개월 뒤 달의 15일 12:00 KST 를 돌려준다.
 * 월 중간·정오라 UTC/KST 월 경계(±9시간)와 월말(28~31일)·연말(12→1월)에서 멀리 떨어져 있고,
 * 고정 시간 오프셋(+N시간)과 달리 실행 날짜가 바뀌어도 "다음 달" 의미가 유지된다. monthsAhead ≥ 1 이면 항상 미래(최소 약 14일 뒤).
 */
export function kstMidMonthFuture(now: Date = new Date(), monthsAhead = 1): Date {
  const { year, month } = kstYearMonth(now);
  const zeroBased = month - 1 + monthsAhead;
  const y = year + Math.floor(zeroBased / 12);
  const m = ((zeroBased % 12) + 12) % 12 + 1;
  return new Date(`${y}-${String(m).padStart(2, "0")}-15T12:00:00+09:00`);
}
