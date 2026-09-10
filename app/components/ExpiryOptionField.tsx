"use client";

/*
  상품(수강권/상품) 만료 기간 옵션 — 켜면 "N일 후"/"특정 날짜"(시즌권처럼 전원 동일 날짜)/
  "매달 자동"(rolling_month, add_rolling_month_product_expiry.sql) 중 골라 자동 만료를
  건다. 끄면 무제한(만료 없음, add_product_expiry_options.sql 참고).
  app/manager/membership-rules(수강권)·app/manager/goods(상품) 두 화면이 공용으로 쓴다.
*/

import DatePicker from "./DatePicker";

export type ExpiryMode = "none" | "days" | "date" | "rolling_month";

export type ExpiryOptionValue = {
  mode: ExpiryMode; days: string; date: string;
  cutoffDay: string; allowEarlyUse: boolean;
};

export default function ExpiryOptionField({
  value,
  onChange,
  disabled,
}: {
  value: ExpiryOptionValue;
  onChange: (next: ExpiryOptionValue) => void;
  disabled?: boolean;
}) {
  const { mode, days, date, cutoffDay, allowEarlyUse } = value;
  return (
    <>
      <div className="set-row" style={{ padding: "14px 0 6px", borderBottom: "none" }}>
        <div className="set-label">기간 지나면 자동 만료</div>
        <button
          className={`switch ${mode !== "none" ? "on" : ""}`}
          disabled={disabled}
          onClick={() => onChange({ mode: mode === "none" ? "days" : "none", days, date, cutoffDay, allowEarlyUse })}
        >
          <span className="knob" />
        </button>
      </div>
      {mode !== "none" && (
        <>
          <div className="mem-filters" style={{ padding: "6px 0" }}>
            <button className={`filter-chip ${mode === "days" ? "on" : ""}`} disabled={disabled}
              onClick={() => onChange({ mode: "days", days, date, cutoffDay, allowEarlyUse })}>N일 후</button>
            <button className={`filter-chip ${mode === "date" ? "on" : ""}`} disabled={disabled}
              onClick={() => onChange({ mode: "date", days, date, cutoffDay, allowEarlyUse })}>특정 날짜</button>
            <button className={`filter-chip ${mode === "rolling_month" ? "on" : ""}`} disabled={disabled}
              onClick={() => onChange({ mode: "rolling_month", days, date, cutoffDay, allowEarlyUse })}>매달 자동</button>
          </div>
          {mode === "days" && (
            <input
              inputMode="numeric" className="input-field" placeholder="예: 30" disabled={disabled}
              value={days} onChange={(e) => onChange({ mode, days: e.target.value, date, cutoffDay, allowEarlyUse })}
            />
          )}
          {mode === "date" && (
            <DatePicker value={date} onChange={(v) => onChange({ mode, days, date: v, cutoffDay, allowEarlyUse })} label="만료일" />
          )}
          {mode === "rolling_month" && (
            <>
              <input
                inputMode="numeric" className="input-field" placeholder="예: 15 (며칠부터 다음 달로 칠지)" disabled={disabled}
                value={cutoffDay} onChange={(e) => onChange({ mode, days, date, cutoffDay: e.target.value, allowEarlyUse })}
              />
              <div className="set-row" style={{ padding: "10px 0 0", borderBottom: "none" }}>
                <div className="set-label">다음 달로 넘어가도 즉시 사용 허용</div>
                <button
                  className={`switch ${allowEarlyUse ? "on" : ""}`}
                  disabled={disabled}
                  onClick={() => onChange({ mode, days, date, cutoffDay, allowEarlyUse: !allowEarlyUse })}
                >
                  <span className="knob" />
                </button>
              </div>
            </>
          )}
          <div className="perm-guide" style={{ margin: "6px 0 0" }}>
            {mode === "days" && "구매일로부터 입력한 일수 뒤 자동 만료돼요."}
            {mode === "date" && "구매 시점과 무관하게 이 상품을 산 회원 전원이 이 날짜에 만료돼요(시즌권 효과)."}
            {mode === "rolling_month" && (
              allowEarlyUse
                ? "입력한 날짜부터는 다음 달 것으로 자동 배정되고, 구매 즉시 사용할 수 있어요."
                : "입력한 날짜부터는 다음 달 것으로 자동 배정되고, 다음 달 1일이 되기 전까지는 예약에 쓸 수 없어요."
            )}
          </div>
        </>
      )}
    </>
  );
}
