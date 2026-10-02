/*
  다중 선택 → 일괄 삭제 순수 로직(상품 관리 / 수강권 관리 공용).
  - 선택 상태는 화면에 "보이는" 항목으로만 유지한다(검색/필터로 숨겨진 항목이 몰래 삭제되지 않게).
*/
export function toggleSelected(selected: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selected);
  if (next.has(id)) next.delete(id); else next.add(id);
  return next;
}

export function selectAllVisible(visibleIds: readonly string[]): Set<string> {
  return new Set(visibleIds);
}

// 화면에 보이는 항목과 교집합만 유효한 선택으로 본다.
export function effectiveSelection(selected: ReadonlySet<string>, visibleIds: readonly string[]): string[] {
  const visible = new Set(visibleIds);
  return [...selected].filter((id) => visible.has(id));
}

export const bulkDeleteConfirmMessage = (n: number) => `선택한 ${n}개 항목을 삭제할까요?`;
export const bulkDeleteToast = (n: number) => `${n}개 삭제했어요`;
