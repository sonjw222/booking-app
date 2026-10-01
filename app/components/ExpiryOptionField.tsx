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
              {/* 2026-10-01(Batch C, C-14) — 기존 "다음 달로 넘어가도 즉시 사용 허용"이라는
                  문구는 위 cutoffDay 입력칸과의 관계(기준일 이후 구매하면 다음 달 걸로
                  자동 배정된다는 전제)를 미리 알아야만 뜻을 알 수 있었다. 실제 동작(코드로
                  확인, calc_rolling_month_dates/fulfill_order의 allow_early_use 분기)은
                  그대로 두고, 제목을 더 쉬운 한 마디로 줄이고 이 토글 바로 아래에 조건까지
                  포함한 1줄 설명을 항상 보이게 했다(기존엔 모드 전체에 대한 안내 문구
                  아래쪽에만 있어서 이 토글과 시각적으로 멀리 떨어져 있었음). */}
              <div className="set-row" style={{ padding: "10px 0 0", borderBottom: "none" }}>
                <div className="set-label">구매 즉시 사용 허용</div>
                <button
                  className={`switch ${allowEarlyUse ? "on" : ""}`}
                  disabled={disabled}
                  onClick={() => onChange({ mode, days, date, cutoffDay, allowEarlyUse: !allowEarlyUse })}
                >
                  <span className="knob" />
                </button>
              </div>
              <div className="perm-guide" style={{ margin: "2px 0 0" }}>
                {allowEarlyUse
                  ? `기준일(매달 ${cutoffDay || "N"}일) 이후에 구매해도, 다음 달 걸로 배정되면서 바로 예약에 쓸 수 있어요.`
                  : `기준일(매달 ${cutoffDay || "N"}일) 이후에 구매하면 다음 달 걸로 배정되고, 다음 달 1일부터 쓸 수 있어요.`}
              </div>
            </>
          )}
          {/* rolling_month은 이제 토글 바로 아래(위 perm-guide)에서 조건까지 포함해
              설명하므로 여기서 다시 반복하지 않는다(같은 설명 두 번 노출 방지). */}
          {mode !== "rolling_month" && (
            <div className="perm-guide" style={{ margin: "6px 0 0" }}>
              {mode === "days" && "구매일로부터 입력한 일수 뒤 자동 만료돼요."}
              {mode === "date" && "구매 시점과 무관하게 이 상품을 산 회원 전원이 이 날짜에 만료돼요(시즌권 효과)."}
            </div>
          )}
        </>
      )}
    </>
  );
}
