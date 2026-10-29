/*
  수강권 서비스 제공기간 · 사전예약기간 계산/표시 (NICEPAY 카드사 심사 요청: "서비스 제공기간(시작일~종료일)과 사전예약기간(결제일~서비스 시작일) 명시").

  이 모듈은 새 정책을 만들지 않는다. 결제 확정 시 서버가 실제로 만드는 값(_issue_membership_and_record_payment, calc_rolling_month_dates)을
  같은 규칙으로 "오늘(KST)에 결제한다면" 기준으로 미리 계산해 보여 줄 뿐이다:
    · 이용 시작일 = 결제일(KST). 예외: 월 갱신형(expiry_mode=rolling_month)에서 early-use 를 허용하지 않으면 시작일은 컷오프 규칙의 달 1일.
    · 만료일 = expiry_mode 에 따라: none → 만료일 없음(null) · days → 결제일+expiry_days · date → 상품의 고정 expiry_date · rolling_month → 컷오프 규칙의 달 말일.
  모르는 값(데이터 없음)은 추측하지 않고 known=false 로 둔다. "모든 수강권이 1년 유효" 같은 문구를 만들지 않는다.

  NICEPAY 입점 기준 점검(checkNicepayLimits): 사전예약기간 ≤ 60일, 서비스 제공기간 ≤ 1년. 만료일이 없는 상품은 상한을 증명할 수 없으므로 별도 분류한다.
  서버 SQL 과 같은 계산인지는 tests/unit/servicePeriod.test.ts 가 고정한다.
*/

export type ExpiryMode = "none" | "days" | "date" | "rolling_month";

/** 상품의 만료 관련 원본 필드(products.expiry_*). null/undefined 는 "알 수 없음". */
export type PeriodSource = {
  expiryMode: ExpiryMode | null | undefined;
  expiryDays?: number | null;
  expiryDate?: string | null;                 // YYYY-MM-DD
  rollingMonthCutoffDay?: number | null;
  rollingMonthAllowEarlyUse?: boolean | null;
};

export type ServicePeriod = {
  known: boolean;
  mode: ExpiryMode | "unknown";
  payDate: string;                            // 결제일(= 계산 기준일, KST)
  startDate: string | null;                   // 이용 시작일(결제일보다 이르면 결제일로 보정 — 실제 DB starts_at 은 rawStartDate)
  rawStartDate: string | null;                // 서버가 memberships.starts_at 에 넣는 값
  endDate: string | null;                     // null = 만료일 없음 또는 알 수 없음
  preBookingDays: number | null;              // 결제일 → 이용 시작일 일수
  expiryDays: number | null;                  // mode=days 일 때만
  serviceSpanDays: number | null;             // 시작일~종료일 사이 일수(null=종료일 없음)
};

const DAY = 86_400_000;
const pad = (n: number) => String(n).padStart(2, "0");
const toUtc = (d: string) => { const [y, m, dd] = d.split("-").map(Number); return Date.UTC(y, m - 1, dd); };
const fromUtc = (t: number) => { const x = new Date(t); return `${x.getUTCFullYear()}-${pad(x.getUTCMonth() + 1)}-${pad(x.getUTCDate())}`; };
export const addDays = (d: string, n: number) => fromUtc(toUtc(d) + n * DAY);
export const diffDays = (a: string, b: string) => Math.round((toUtc(b) - toUtc(a)) / DAY);
const isDate = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

/** 기준 시각의 KST 날짜(YYYY-MM-DD). */
export function kstToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** 같은 월/일의 1년 뒤(윤일은 말일로 보정). */
export function addOneYear(d: string): string {
  const [y, m, dd] = d.split("-").map(Number);
  const last = new Date(Date.UTC(y + 1, m, 0)).getUTCDate();
  return `${y + 1}-${pad(m)}-${pad(Math.min(dd, last))}`;
}

/** calc_rolling_month_dates(p_purchase_ts, p_cutoff_day) 와 같은 규칙. */
export function calcRollingMonthDates(payDate: string, cutoffDay: number): { startsAt: string; expiresAt: string } {
  const [y, m, d] = payDate.split("-").map(Number);
  const useNext = d >= cutoffDay;
  const firstOfTarget = useNext ? Date.UTC(y, m, 1) : Date.UTC(y, m - 1, 1);   // 다음 달 1일 또는 이번 달 1일
  const t = new Date(firstOfTarget);
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0));   // 그 달 말일
  return { startsAt: fromUtc(firstOfTarget), expiresAt: fromUtc(last.getTime()) };
}

const UNKNOWN = (payDate: string): ServicePeriod => ({ known: false, mode: "unknown", payDate, startDate: null, rawStartDate: null, endDate: null, preBookingDays: null, expiryDays: null, serviceSpanDays: null });

/** "payDate(기본: 오늘 KST)에 결제하면" 서버가 만들 이용기간. 입력이 불충분하면 known=false(추측 금지). */
export function computeServicePeriod(src: PeriodSource | null | undefined, payDate: string = kstToday()): ServicePeriod {
  if (!src || !src.expiryMode) return UNKNOWN(payDate);
  const base = { payDate, expiryDays: null as number | null };
  switch (src.expiryMode) {
    case "none":
      return { ...base, known: true, mode: "none", startDate: payDate, rawStartDate: payDate, endDate: null, preBookingDays: 0, serviceSpanDays: null };
    case "days": {
      if (typeof src.expiryDays !== "number" || !Number.isFinite(src.expiryDays) || src.expiryDays < 0) return UNKNOWN(payDate);
      const end = addDays(payDate, Math.trunc(src.expiryDays));
      return { ...base, known: true, mode: "days", startDate: payDate, rawStartDate: payDate, endDate: end, preBookingDays: 0, expiryDays: Math.trunc(src.expiryDays), serviceSpanDays: diffDays(payDate, end) };
    }
    case "date": {
      if (!isDate(src.expiryDate)) return UNKNOWN(payDate);
      return { ...base, known: true, mode: "date", startDate: payDate, rawStartDate: payDate, endDate: src.expiryDate, preBookingDays: 0, serviceSpanDays: diffDays(payDate, src.expiryDate) };
    }
    case "rolling_month": {
      const cutoff = src.rollingMonthCutoffDay;
      if (typeof cutoff !== "number" || !Number.isInteger(cutoff) || cutoff < 1 || cutoff > 31) return UNKNOWN(payDate);
      const rm = calcRollingMonthDates(payDate, cutoff);
      const raw = src.rollingMonthAllowEarlyUse ? payDate : rm.startsAt;          // early-use 허용이면 서버는 starts_at 을 결제일로 둔다
      const effective = raw < payDate ? payDate : raw;                             // 컷오프 전(이번 달 1일 시작)이면 이미 시작된 상태 → 결제일부터 이용
      return { ...base, known: true, mode: "rolling_month", startDate: effective, rawStartDate: raw, endDate: rm.expiresAt, preBookingDays: diffDays(payDate, effective), serviceSpanDays: diffDays(effective, rm.expiresAt) };
    }
    default:
      return UNKNOWN(payDate);
  }
}

export type NicepayLimitFlag = "ok" | "unknown" | "open_ended" | "service_over_1y" | "prebooking_over_60d";
export const NICEPAY_MAX_PREBOOKING_DAYS = 60;

/** NICEPAY 입점 기준(사전예약 최대 60일, 서비스 제공기간 최대 1년) 점검. 반환이 ["ok"] 가 아니면 별도 확인 대상. */
export function checkNicepayLimits(p: ServicePeriod): NicepayLimitFlag[] {
  if (!p.known) return ["unknown"];
  const flags: NicepayLimitFlag[] = [];
  if (p.preBookingDays != null && p.preBookingDays > NICEPAY_MAX_PREBOOKING_DAYS) flags.push("prebooking_over_60d");
  if (p.endDate == null) flags.push("open_ended");                              // 만료일이 없으면 1년 이내임을 증명할 수 없다
  else if (p.startDate && p.endDate > addOneYear(p.startDate)) flags.push("service_over_1y");
  return flags.length ? flags : ["ok"];
}

const ko = (d: string) => { const [y, m, dd] = d.split("-").map(Number); return `${y}년 ${m}월 ${dd}일`; };

export type PeriodText = { prebooking: string; service: string; note: string | null };

/** 고객에게 보여 줄 문구. 계산 기준일은 결제일(오늘)이다. */
export function describeServicePeriod(p: ServicePeriod): PeriodText | null {
  if (!p.known || !p.startDate) return null;
  const prebooking = p.preBookingDays === 0
    ? `없음 — 결제 완료일(${ko(p.payDate)})부터 바로 이용해요`
    : `결제일(${ko(p.payDate)}) ~ 이용 시작 전날(${ko(addDays(p.startDate, -1))}) · ${p.preBookingDays}일`;
  let service: string; let note: string | null = null;
  switch (p.mode) {
    case "none": service = `${ko(p.startDate)}부터 · 만료일 없음(별도 이용 종료일이 없는 상품)`; break;
    case "days": service = `${ko(p.startDate)} ~ ${ko(p.endDate!)} (결제일로부터 ${p.expiryDays}일)`; break;
    case "date": service = `${ko(p.startDate)} ~ ${ko(p.endDate!)} (상품에 지정된 만료일)`; break;
    case "rolling_month": service = `${ko(p.startDate)} ~ ${ko(p.endDate!)} (매월 갱신형)`; if (p.rawStartDate && p.rawStartDate < p.payDate) note = "이번 달 이용분이라 결제일부터 이용해요"; break;
    default: return null;
  }
  return { prebooking, service, note };
}

/** 기간 정보를 알 수 없을 때(비로그인 공개 목록 등)의 공통 안내 — 상품별 날짜를 만들어 내지 않는다. */
export const PERIOD_GENERIC_NOTICE =
  "이용 시작일은 결제 완료일이에요(매월 갱신형 상품은 상품 안내에 표시된 시작일). 이용 종료일과 사전예약기간은 상품마다 달라 센터 화면의 상품 안내와 결제 화면에서 날짜로 확인할 수 있어요.";
