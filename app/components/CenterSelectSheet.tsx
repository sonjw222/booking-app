"use client";

/*
  실기기 QA(2026-09-25) — 예약 화면 "센터 선택" 시트. 예전엔 .filter-chip(알약) 전체 폭 버튼을
  그대로 재사용해 선택 항목은 거대한 navy 알약, 나머지는 큰 회색 알약, 닫기는 별도 큰
  블록이었다. 앱의 다른 시트(예: 센터 상세 "수강권 · 상품 구매")와 같은 패턴으로 통일:
  .sheet + 상단 .sheet-title 안의 X(.sheet-close-btn), 옵션은 같은 높이의 행(.sheet-option),
  선택 표시는 체크 아이콘 + 강조 텍스트(전체 채움 없음). 옵션이 많으면 .sheet 자체가
  max-height + overflow-y로 내부 스크롤, 하단 safe-area는 .sheet 하단 패딩에서 처리.
*/
import UiIcon from "./UiIcon";

export type CenterOption = { id: string | null; label: string; selected: boolean };

// "전체 센터"(id=null) + 센터 목록 → 선택 상태가 계산된 옵션 목록(순수 함수 — 단위 테스트 대상).
export function buildCenterOptions(centers: { id: string; name: string }[], selectedId: string | null | undefined): CenterOption[] {
  return [
    { id: null, label: "전체 센터", selected: !selectedId },
    ...centers.map((c) => ({ id: c.id, label: c.name, selected: selectedId === c.id })),
  ];
}

export default function CenterSelectSheet({ centers, selectedId, onSelect, onClose }: {
  centers: { id: string; name: string }[];
  selectedId: string | null | undefined;
  onSelect: (id: string | null) => void;
  onClose: () => void;
}) {
  const options = buildCenterOptions(centers, selectedId);
  return (
    <div className="sheet-overlay" onClick={onClose}>
      <div className="sheet center-select-sheet" role="dialog" aria-modal="true" aria-label="센터 선택" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-title">
          센터 선택
          <button type="button" className="sheet-close-btn" aria-label="닫기" onClick={onClose}>
            <UiIcon name="close" size={20} />
          </button>
        </div>
        <div role="listbox" aria-label="센터 목록">
          {options.map((o) => (
            <button
              key={o.id ?? "__all"}
              type="button"
              role="option"
              aria-selected={o.selected}
              className={`sheet-option ${o.selected ? "on" : ""}`}
              onClick={() => onSelect(o.id)}
            >
              <span className="sheet-option-label">{o.label}</span>
              {o.selected && (
                <svg className="sheet-option-check" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="m5 12.5 4.5 4.5L19 7.5" />
                </svg>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
