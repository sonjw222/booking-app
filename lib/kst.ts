/*
  Asia/Seoul(KST, UTC+9) 기준 날짜/시간 계산 공용 유틸.
  - JS Date의 "로컬 머신 타임존"에 의존하는 계산(new Date(year, month, day) 등)을 쓰지 않는다 —
    개발자 맥/GitHub Actions(UTC)/Vercel 어디서 실행해도 항상 같은 결과가 나오도록, KST
    오프셋(+09:00)을 문자열에 명시한 뒤 Date로 파싱해 toISOString()(항상 UTC, machine-TZ
    무관)으로 변환하는 방식만 쓴다.
  - toKstIso는 원래 lib/classes.ts에 있던 것과 동일한 구현이다(중복 생성 아님 — 이 파일로
    옮기고 lib/classes.ts는 이 파일을 재사용하도록 정리했다).
*/

// "2026-07-14" + "07:10" → "2026-07-14T07:10:00+09:00" (KST 명시 ISO 문자열)
export function toKstIso(date: string, time: string): string {
  return `${date}T${time}:00+09:00`;
}

// 특정 KST 연/월의 "달력상 그 달"을 UTC 절대시각 범위로 변환한다.
// month는 1~12. 반환값은 timestamptz 컬럼과 .gte()/.lt() 비교에 바로 쓸 수 있는 UTC ISO
// 문자열(끝이 'Z')이다. 12월→다음해 1월 전환은 자동으로 처리된다(항상 "그 달 1일"만 다루므로
// 윤년 2월처럼 "그 달의 마지막 날짜"를 계산할 필요 자체가 없다 — 다음 달 1일 직전까지로
// 범위를 잡기 때문).
export function getKstMonthUtcRange(year: number, month: number): { startUtcIso: string; endUtcIso: string } {
  const startDate = `${year}-${String(month).padStart(2, "0")}-01`;
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const endDate = `${nextYear}-${String(nextMonth).padStart(2, "0")}-01`;

  return {
    startUtcIso: new Date(toKstIso(startDate, "00:00")).toISOString(),
    endUtcIso: new Date(toKstIso(endDate, "00:00")).toISOString(),
  };
}
