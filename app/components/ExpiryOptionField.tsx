"use client";

/*
  상품(수강권/상품) 만료 기간 옵션 — 켜면 "N일 후" 또는 "특정 날짜"(시즌권처럼 전원 동일 날짜)
  중 골라 자동 만료를 건다. 끄면 무제한(만료 없음, add_product_expiry_options.sql 참고).
  app/manager/membership-rules(수강권)·app/manager/goods(상품) 두 화면이 공용으로 쓴다.
*/

import DatePicker from "./DatePicker";

export type ExpiryMode = "none" | "days" | "date";

export type ExpiryOptionValue = { mode: ExpiryMode; days: string; date: string };

export default function ExpiryOptionField({
  value,
  onChange,
  disabled,
}: {
  value: ExpiryOptionValue;
  onChange: (next: ExpiryOptionValue) => void;
  disabled?: boolean;
}) {
  const { mode, days, date } = value;
  return (
    <>
      <div className="set-row" style={{ padding: "14px 0 6px", borderBottom: "none" }}>
        <div className="set-label">기간 지나면 자동 만료</div>
        <button
          className={`switch ${mode !== "none" ? "on" : ""}`}
          disabled={disabled}
          onClick={() => onChange({ mode: mode === "none" ? "days" : "none", days, date })}
        >
          <span className="knob" />
        </button>
      </div>
      {mode !== "none" && (
        <>
          <div className="mem-filters" style={{ padding: "6px 0" }}>
            <button className={`filter-chip ${mode === "days" ? "on" : ""}`} disabled={disabled}
              onClick={() => onChange({ mode: "days", days, date })}>N일 후</button>
            <button className={`filter-chip ${mode === "date" ? "on" : ""}`} disabled={disabled}
              onClick={() => onChange({ mode: "date", days, date })}>특정 날짜</button>
          </div>
          {mode === "days" ? (
            <input
              inputMode="numeric" className="input-field" placeholder="예: 30" disabled={disabled}
              value={days} onChange={(e) => onChange({ mode, days: e.target.value, date })}
            />
          ) : (
            <DatePicker value={date} onChange={(v) => onChange({ mode, days, date: v })} label="만료일" />
          )}
          <div className="perm-guide" style={{ margin: "6px 0 0" }}>
            {mode === "days"
              ? "구매일로부터 입력한 일수 뒤 자동 만료돼요."
              : "구매 시점과 무관하게 이 상품을 산 회원 전원이 이 날짜에 만료돼요(시즌권 효과)."}
          </div>
        </>
      )}
    </>
  );
}
