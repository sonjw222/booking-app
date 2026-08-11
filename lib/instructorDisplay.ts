/*
  담당 강사 이름 배열을 화면에 보여줄 한 줄짜리 문자열로 바꾸는 공용 포맷터.
  회원 예약 화면(app/reservation/page.tsx)과 관리자 수업 목록(app/manager/classes/page.tsx)이
  같은 문구·임계값을 쓰도록 한 곳에 모아 재사용한다(수동 QA에서 발견된 표시 문제 수정,
  2026-08-12 — 임계값(2명까지는 이름 나열, 3명부터 "외 N명")은 기존 그대로 유지하고, 두
  화면에 중복돼 있던 동일 로직을 이 함수로 추출만 했다).
*/
export function formatInstructorNames(names: string[]): string | null {
  if (names.length === 0) return null;
  if (names.length > 2) return `${names[0]} 외 ${names.length - 1}명`;
  return names.join(" · ");
}
