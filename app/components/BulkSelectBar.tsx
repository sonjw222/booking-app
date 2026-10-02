"use client";

/*
  다중 선택 삭제 바(상품 관리 / 수강권 관리 공용).
  평상시에는 "선택" 버튼 하나만 보이고, 선택 모드에서만 전체 선택/해제·선택 개수·선택 삭제가 나타난다.
*/
type Props = {
  selecting: boolean;
  selectedCount: number;
  totalVisible: number;
  busy: boolean;
  onEnter: () => void;
  onCancel: () => void;
  onSelectAll: () => void;
  onClear: () => void;
  onDelete: () => void;
  // 선택한 항목에 대한 추가 일괄 작업(예: 수강권 예약조건 일괄 설정). 선택이 0개면 비활성.
  extraAction?: { label: string; onClick: () => void };
};

export default function BulkSelectBar({ selecting, selectedCount, totalVisible, busy, onEnter, onCancel, onSelectAll, onClear, onDelete, extraAction }: Props) {
  if (!selecting) {
    return (
      <div className="bulk-bar idle">
        <button type="button" className="quiet-action" disabled={busy || totalVisible === 0} onClick={onEnter}>선택</button>
      </div>
    );
  }
  const allSelected = totalVisible > 0 && selectedCount === totalVisible;
  return (
    <div className="bulk-bar" role="toolbar" aria-label="선택 삭제">
      <div className="bulk-count" aria-live="polite">{selectedCount}개 선택</div>
      <div className="bulk-actions">
        <button type="button" className="quiet-action" disabled={busy} onClick={allSelected ? onClear : onSelectAll}>
          {allSelected ? "전체 해제" : "전체 선택"}
        </button>
        {extraAction && <button type="button" className="quiet-action" disabled={busy || selectedCount === 0} onClick={extraAction.onClick}>{extraAction.label}</button>}
        <button type="button" className="quiet-action danger" disabled={busy || selectedCount === 0} onClick={onDelete}>선택 삭제</button>
        <button type="button" className="quiet-action" disabled={busy} onClick={onCancel}>취소</button>
      </div>
    </div>
  );
}
