"use client";

import { useId, useState } from "react";
import type { ScheduleRule } from "../../lib/passes";
import { groupRulesByDay, summarizeRules } from "../../lib/ruleDisplay";

/*
  회원 구매 sheet 상품 카드의 예약조건(설명용) accordion. 기본 collapsed, 상품마다 독립 state.
  구매에 필요한 요일/시간 selector와는 별개 — 이 목록은 "예약 가능한 수업" 안내일 뿐이다.
  토글은 전용 버튼만(카드 전체 클릭 아님)이라 담기/구매와 충돌하지 않는다. 조건 0개면 아무것도 그리지 않는다.
*/
export default function ProductRuleAccordion({ rules }: { rules?: ScheduleRule[] }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  if (!rules || rules.length === 0) return null;
  const summary = summarizeRules(rules)!;
  return (
    <div className="rule-acc">
      <button type="button" className="rule-acc-toggle" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((v) => !v)}>
        <span className="rule-acc-summary">{summary}</span>
        <span className="rule-acc-more">{open ? "접기" : "자세히"}<span className={`rule-acc-chevron${open ? " open" : ""}`} aria-hidden="true">›</span></span>
      </button>
      {open && (
        <div id={panelId} className="rule-acc-panel">
          {groupRulesByDay(rules).map((g) => (
            <div key={g.dayOfWeek ?? "all"} className="rule-day">
              <div className="rule-day-label">{g.label}</div>
              {g.rows.map((r) => (
                <div key={r.id} className="rule-row"><span className="rule-time">{r.time}</span><span className="rule-title">{r.title}</span></div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
