"use client";

import type { KindFilter } from "../../lib/catalogFilter";

/*
  수강권·상품 목록 상단의 검색 + 필터 chip(회원 구매 sheet / 관리자 수강권 설정 공용, 2026-10-01).
  상태는 부모가 들고 있고(검색어를 지워도 필터 유지) 이 컴포넌트는 표시/입력만 한다.
  - input font-size 16px(iOS 자동 확대 방지), 검색어가 있을 때만 X(검색어 지우기)
  - chip은 기존 filter-chip + aria-pressed, 그룹 chip은 가로 스크롤 한 줄(페이지 가로 스크롤 없음)
  - sticky: sheet/페이지 안에서 스크롤해도 다시 좁힐 수 있게 상단 고정. 입력/chip 영역은 공용 Bottom Sheet의
    drag handle과 별개라(handle에서 시작한 제스처만 dismiss) drag로 오인되지 않는다.
*/
type Props = {
  query: string;
  onQuery: (q: string) => void;
  placeholder: string;
  searchLabel: string;
  // 종류 필터(회원 구매 화면만). 생략하면 종류 chip을 그리지 않는다.
  kind?: KindFilter;
  onKind?: (k: KindFilter) => void;
  groups: string[];
  group: string | null;
  onGroup: (g: string | null) => void;
  resultText?: string | null;   // 예: "12개" — 작은 보조 텍스트
  sticky?: boolean;
};

const KINDS: { id: KindFilter; label: string }[] = [
  { id: "all", label: "전체" }, { id: "pass", label: "수강권" }, { id: "goods", label: "상품" },
];

export default function CatalogSearchFilter({
  query, onQuery, placeholder, searchLabel, kind, onKind, groups, group, onGroup, resultText, sticky = true,
}: Props) {
  const showGroups = groups.length > 0 && kind !== "goods";
  return (
    <div className={`catalog-filter${sticky ? " is-sticky" : ""}`}>
      <div className="catalog-search">
        <input
          type="search" inputMode="search" enterKeyHint="search" autoComplete="off"
          className="catalog-search-input" aria-label={searchLabel} placeholder={placeholder}
          value={query} onChange={(e) => onQuery(e.target.value)}
        />
        {query !== "" && (
          <button type="button" className="catalog-search-clear" aria-label="검색어 지우기" onClick={() => onQuery("")}>×</button>
        )}
      </div>
      {kind !== undefined && onKind && (
        <div className="catalog-chips" role="group" aria-label="종류 필터">
          {KINDS.map((k) => (
            <button key={k.id} type="button" aria-pressed={kind === k.id}
              className={`filter-chip ${kind === k.id ? "on" : ""}`} onClick={() => onKind(k.id)}>{k.label}</button>
          ))}
        </div>
      )}
      {showGroups && (
        <div className="catalog-chips" role="group" aria-label="그룹 필터">
          <button type="button" aria-pressed={group === null}
            className={`filter-chip ${group === null ? "on" : ""}`} onClick={() => onGroup(null)}>전체</button>
          {groups.map((g) => (
            <button key={g} type="button" aria-pressed={group === g}
              className={`filter-chip ${group === g ? "on" : ""}`} onClick={() => onGroup(g)}>{g}</button>
          ))}
        </div>
      )}
      {resultText && <div className="catalog-result-count" aria-live="polite">{resultText}</div>}
    </div>
  );
}
