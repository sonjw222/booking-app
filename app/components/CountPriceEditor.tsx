"use client";

import { useState } from "react";
import type { TierDraft } from "../../lib/selectableCount";
import { fillDraftsFromUnit } from "../../lib/goodsForm";

/*
  구매자가 횟수 선택 — 회차별 가격표 편집기(/manager/goods, /manager/membership-rules 공용, 2026-10-01).
  행마다 [☑ N회] [가격]: 체크 해제한 회차는 판매하지 않는다(가격표에 저장되지 않음 → 회원 선택지에 안 나옴).
  "기준 1회 가격 → 기본 가격 채우기"는 편의 기능일 뿐, 저장되는 값은 행별 입력값이다.
*/
export default function CountPriceEditor({
  rows, onChange, disabled,
}: { rows: TierDraft[]; onChange: (rows: TierDraft[]) => void; disabled?: boolean }) {
  const [unit, setUnit] = useState("");
  const setRow = (count: number, patch: Partial<TierDraft>) =>
    onChange(rows.map((r) => (r.count === count ? { ...r, ...patch } : r)));
  const unitNum = Number(unit.replace(/[^0-9]/g, ""));

  return (
    <div className="count-price-editor">
      <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>회차별 가격</div>
      <div className="count-price-fill">
        <input aria-label="기준 1회 가격" inputMode="numeric" className="input-field" placeholder="기준 1회 가격 (예: 6000)"
          value={unit} disabled={disabled} onChange={(e) => setUnit(e.target.value.replace(/[^0-9]/g, ""))} />
        <button type="button" className="ghost-btn" disabled={disabled || !(unitNum > 0)}
          onClick={() => onChange(fillDraftsFromUnit(unitNum, rows))}>기본 가격 채우기</button>
      </div>
      <div className="count-price-rows">
        {rows.map((r) => (
          <label key={r.count} className={`count-price-row ${r.enabled ? "" : "off"}`}>
            <input type="checkbox" aria-label={`${r.count}회 판매`} checked={r.enabled} disabled={disabled}
              onChange={(e) => setRow(r.count, { enabled: e.target.checked })} />
            <span className="count-price-count">{r.count}회</span>
            <input aria-label={`${r.count}회 가격`} inputMode="numeric" className="input-field" placeholder="가격(원)"
              value={r.price} disabled={disabled || !r.enabled}
              onChange={(e) => setRow(r.count, { price: e.target.value.replace(/[^0-9]/g, "") })} />
          </label>
        ))}
      </div>
      <div className="perm-guide" style={{ margin: "6px 0 0" }}>
        회원이 구매할 때 가격이 등록된 횟수 중에서 고릅니다. 예: 1회 6,000원 · 6회 34,000원
      </div>
    </div>
  );
}
