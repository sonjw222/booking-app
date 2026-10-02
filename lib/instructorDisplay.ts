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

/*
  담당 강사 "선택한 순서"(2026-10-02) — 선택 순서가 source of truth다.
  - toggleTrainerSelection: 선택하지 않은 강사를 누르면 배열 맨 뒤에 추가, 선택된 강사를 다시 누르면 제거(다시 선택하면 맨 뒤).
  - trainerPreviewItems: 저장 전 "표시 순서 미리보기"용 번호 목록(선택 순서 그대로, 이름을 모르는 계정은 건너뜀).
  - appendTrainerNames: class_trainer_names RPC 행(서버가 class_id, sort_order 순으로 정렬해 돌려줌)을 수업별 이름 배열로 모은다 — 행 순서를 그대로 유지한다.
*/
export function toggleTrainerSelection(order: readonly string[], accountId: string): string[] {
  return order.includes(accountId) ? order.filter((x) => x !== accountId) : [...order, accountId];
}

export const TRAINER_PREVIEW_EMPTY = "담당 강사를 선택하면 표시 순서를 미리 볼 수 있어요";

export function trainerPreviewItems(order: readonly string[], nameByAccountId: Readonly<Record<string, string>>): { position: number; accountId: string; name: string }[] {
  const out: { position: number; accountId: string; name: string }[] = [];
  for (const id of order) {
    const name = nameByAccountId[id];
    if (name) out.push({ position: out.length + 1, accountId: id, name });
  }
  return out;
}

export function appendTrainerNames(target: Record<string, string[]>, rows: readonly { class_id: string; name?: string | null }[] | null | undefined): void {
  for (const r of rows ?? []) {
    if (!r.name) continue;
    (target[r.class_id] ??= []).push(r.name);
  }
}
