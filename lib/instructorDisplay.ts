/*
  담당 강사 이름 배열을 화면에 보여줄 한 줄짜리 문자열로 바꾸는 공용 포맷터.
  회원 예약 화면(app/reservation/page.tsx)과 관리자 수업 목록(app/manager/classes/page.tsx)이
  같은 문구·임계값을 쓰도록 한 곳에 모아 재사용한다.

  2026-08-12 수동 QA 피드백 반영: 최대 2명까지는 이름을 전부 보여주고("A, B"), 3명부터
  앞의 2명 + "외 N명"으로 줄인다("A, B 외 1명"). 이름 사이는 쉼표로 나열하고(같은 종류의
  항목을 나열하는 구분자), 이 문자열을 센터명/시간 등 다른 정보와 이어붙일 때는 호출하는
  쪽에서 " · "를 쓴다(다른 종류의 정보를 구분하는 구분자) — 이 함수는 그 바깥쪽 구분자는
  포함하지 않는다.
*/
export function formatInstructorNames(names: string[]): string | null {
  if (names.length === 0) return null;
  if (names.length <= 2) return names.join(", ");
  return `${names[0]}, ${names[1]} 외 ${names.length - 2}명`;
}
