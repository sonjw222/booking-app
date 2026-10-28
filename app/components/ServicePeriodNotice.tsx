"use client";

/*
  수강권 이용기간 안내 — NICEPAY 카드사 심사 요청("서비스 제공기간(시작일~종료일)과 사전예약기간(결제일~서비스 시작일) 명시").
  날짜는 lib/servicePeriod.ts 가 서버의 실제 계산 규칙으로 "오늘(KST) 결제한다면" 기준으로 만든다. 기간 정보를 알 수 없으면(공개 목록 등) 날짜를 만들지 않고
  공통 안내만 보인다 — "모든 수강권이 1년 유효" 같은 문구는 쓰지 않는다.
  variant: "block"(상세/결제 화면, 정보 없을 때 공통 안내 표시) · "compact"(목록 행, 정보 없으면 아무것도 안 그림 — 페이지 단위 공통 안내가 따로 있음)
*/
import { useMemo } from "react";
import { computeServicePeriod, describeServicePeriod, kstToday, PERIOD_GENERIC_NOTICE, type PeriodSource } from "../../lib/servicePeriod";

export default function ServicePeriodNotice({ source, variant = "block" }: { source: PeriodSource | null | undefined; variant?: "block" | "compact" }) {
  const text = useMemo(() => describeServicePeriod(computeServicePeriod(source, kstToday())), [source]);
  if (!text) {
    return variant === "compact" ? null : <div className="service-period is-generic" role="note" data-testid="service-period-generic">{PERIOD_GENERIC_NOTICE}</div>;
  }
  return (
    <dl className={`service-period${variant === "compact" ? " is-compact" : ""}`} data-testid="service-period" aria-label="이용기간 안내">
      <div><dt>사전예약기간 <span>(결제일 ~ 이용 시작일)</span></dt><dd data-testid="service-period-prebooking">{text.prebooking}</dd></div>
      <div><dt>서비스 제공기간 <span>(이용 시작일 ~ 종료일)</span></dt><dd data-testid="service-period-service">{text.service}</dd></div>
      {text.note && <div className="service-period-note">{text.note}</div>}
    </dl>
  );
}

/** 페이지 단위 공통 안내(목록 화면 상단/하단). */
export function ServicePeriodGenericNote() {
  return <div className="service-period is-generic" role="note" data-testid="service-period-generic">{PERIOD_GENERIC_NOTICE}</div>;
}
