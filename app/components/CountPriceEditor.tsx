"use client";

import { memo, useCallback, useEffect, useRef, useState } from "react";
import type { TierDraft } from "../../lib/selectableCount";
import { patchTierRow } from "../../lib/tierRows";
import { fillDraftsFromUnit, MAX_TIER_COUNT, maxTierCount, resizeTierDrafts } from "../../lib/goodsForm";

/*
  구매자가 횟수 선택 — 회차별 가격표 편집기(/manager/goods, /manager/membership-rules 공용, 2026-10-01).
  - "판매 최대 횟수"를 먼저 정하면 1회~최대 횟수까지 행이 생긴다(센터마다 5·8·20·30회 등). 늘리면 행이 추가되고,
    줄일 때 큰 회차에 판매 중인 가격이 있으면 조용히 지우지 않고 경고와 함께 그 회차까지 남긴다.
  - 행마다 [☑ N회] [가격]: 체크 해제한 회차는 판매하지 않는다(가격표에 저장되지 않음 → 회원 선택지에 안 나옴).
  - "기준 1회 가격 → 기본 가격 채우기"는 편의 기능일 뿐(현재 행 수만큼 unit×count), 저장되는 값은 행별 입력값이다.
*/
// 행 단위 memo(PERF-041): 최대 100행이라 한 글자 입력마다 전체 행이 리렌더되던 것을, 바뀐 행만 리렌더하도록 분리.
// patchTierRow가 바뀌지 않은 행의 참조를 유지하고 콜백은 안정적이라 memo가 실제로 건너뛴다.
const TierRow = memo(function TierRow({
  row, disabled, onEnabled, onPrice,
}: { row: TierDraft; disabled?: boolean; onEnabled: (count: number, enabled: boolean) => void; onPrice: (count: number, price: string) => void }) {
  const r = row;
  return (
    <label className={`count-price-row ${r.enabled ? "" : "off"}`}>
      <input type="checkbox" aria-label={`${r.count}회 판매`} checked={r.enabled} disabled={disabled}
        onChange={(e) => onEnabled(r.count, e.target.checked)} />
      <span className="count-price-count">{r.count}회</span>
      <input aria-label={`${r.count}회 가격`} inputMode="numeric" className="input-field" placeholder="가격(원)"
        value={r.price} disabled={disabled || !r.enabled}
        onChange={(e) => onPrice(r.count, e.target.value.replace(/[^0-9]/g, ""))} />
    </label>
  );
});

export default function CountPriceEditor({
  rows, onChange, disabled,
}: { rows: TierDraft[]; onChange: (rows: TierDraft[]) => void; disabled?: boolean }) {
  const [unit, setUnit] = useState("");
  const rowMax = maxTierCount(rows);
  const [maxText, setMaxText] = useState(String(rowMax));
  const [editingMax, setEditingMax] = useState(false);
  const [blockedBy, setBlockedBy] = useState<number | null>(null);

  // 다른 상품을 열거나 값이 외부에서 바뀌면 입력창을 실제 행 수에 맞춘다(입력 중에는 건드리지 않음).
  useEffect(() => { if (!editingMax) setMaxText(String(rowMax)); }, [rowMax, editingMax]);

  // 행 콜백은 최신 rows/onChange를 ref로 읽어 참조가 고정된다(행 memo 전제).
  const rowsRef = useRef(rows);
  const onChangeRef = useRef(onChange);
  useEffect(() => { rowsRef.current = rows; onChangeRef.current = onChange; });
  const onRowEnabled = useCallback((count: number, enabled: boolean) =>
    onChangeRef.current(patchTierRow(rowsRef.current, count, { enabled })), []);
  const onRowPrice = useCallback((count: number, price: string) =>
    onChangeRef.current(patchTierRow(rowsRef.current, count, { price })), []);
  const unitNum = Number(unit.replace(/[^0-9]/g, ""));

  function changeMax(text: string) {
    const clean = text.replace(/[^0-9]/g, "");
    setMaxText(clean);
    const n = Number(clean);
    if (!(n >= 1)) return;                       // 비었거나 0이면 행을 건드리지 않는다
    const res = resizeTierDrafts(rows, n);
    setBlockedBy(res.blockedBy);
    if (res.effectiveMax !== rowMax || res.rows.length !== rows.length) onChange(res.rows);
  }

  // 행에서 판매 중인 가격을 해제/삭제해 줄일 수 있게 되었는지 다시 확인(경고 자동 해제)
  const stillBlocked = blockedBy !== null && rows.some((r) => r.count > Number(maxText) && r.enabled && r.price !== "");

  return (
    <div className="count-price-editor">
      <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>판매 최대 횟수</div>
      <div className="count-price-max">
        <input aria-label="판매 최대 횟수" inputMode="numeric" className="input-field" placeholder="예: 8"
          value={maxText} disabled={disabled} maxLength={3}
          onFocus={() => setEditingMax(true)}
          onBlur={() => { setEditingMax(false); setMaxText(String(maxTierCount(rows))); }}
          onChange={(e) => changeMax(e.target.value)} />
        <span className="count-price-max-unit">회</span>
        <span className="count-price-max-cap">최대 {MAX_TIER_COUNT}회</span>
      </div>
      {stillBlocked && (
        <div className="perm-guide is-warning" role="alert" style={{ margin: "6px 0 0" }}>
          {blockedBy}회까지 판매 중인 가격이 있어 줄일 수 없어요. 줄이려면 그 회차의 체크를 해제하거나 가격을 지워주세요.
        </div>
      )}

      <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>회차별 가격</div>
      <div className="count-price-fill">
        <input aria-label="기준 1회 가격" inputMode="numeric" className="input-field" placeholder="기준 1회 가격 (예: 6000)"
          value={unit} disabled={disabled} onChange={(e) => setUnit(e.target.value.replace(/[^0-9]/g, ""))} />
        <button type="button" className="ghost-btn count-price-fill-btn" disabled={disabled || !(unitNum > 0)}
          onClick={() => onChange(fillDraftsFromUnit(unitNum, rows))}>가격 채우기</button>
      </div>
      <div className="count-price-rows">
        {rows.map((r) => (
          <TierRow key={r.count} row={r} disabled={disabled} onEnabled={onRowEnabled} onPrice={onRowPrice} />
        ))}
      </div>
      <div className="perm-guide" style={{ margin: "6px 0 0" }}>
        회원이 구매할 때 가격이 등록된 횟수 중에서 고릅니다. 예: 1회 6,000원 · 6회 34,000원
      </div>
    </div>
  );
}
