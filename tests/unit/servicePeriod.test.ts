import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import {
  addDays, addOneYear, calcRollingMonthDates, checkNicepayLimits, computeServicePeriod, describeServicePeriod, diffDays, kstToday, PERIOD_GENERIC_NOTICE, type PeriodSource,
} from "../../lib/servicePeriod";

describe("kstToday / 날짜 산술", () => {
  it("KST 날짜 경계: UTC 15:00 이후는 KST 다음 날", () => {
    expect(kstToday(new Date("2026-10-26T14:59:59Z"))).toBe("2026-10-26");
    expect(kstToday(new Date("2026-10-26T15:00:00Z"))).toBe("2026-10-27");
  });
  it("addDays/diffDays/addOneYear(윤일 보정)", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01"); expect(diffDays("2026-10-01", "2026-10-31")).toBe(30);
    expect(addOneYear("2028-02-29")).toBe("2029-02-28"); expect(addOneYear("2026-10-27")).toBe("2027-10-27");
  });
});

describe("computeServicePeriod — 서버 규칙 그대로, 모르면 추측하지 않음", () => {
  const D = "2026-10-27";
  it("expiry_mode=none: 오늘 시작·만료일 없음·사전예약 0일", () => {
    const p = computeServicePeriod({ expiryMode: "none" }, D);
    expect(p).toMatchObject({ known: true, mode: "none", startDate: D, endDate: null, preBookingDays: 0, serviceSpanDays: null });
  });
  it("expiry_mode=days: 결제일 + N일", () => {
    const p = computeServicePeriod({ expiryMode: "days", expiryDays: 90 }, D);
    expect(p).toMatchObject({ known: true, startDate: D, endDate: "2027-01-25", expiryDays: 90, serviceSpanDays: 90, preBookingDays: 0 });
  });
  it("expiry_mode=date: 상품의 고정 만료일(없는 만료일을 만들지 않는다)", () => {
    expect(computeServicePeriod({ expiryMode: "date", expiryDate: "2027-03-31" }, D)).toMatchObject({ known: true, endDate: "2027-03-31", startDate: D });
    expect(computeServicePeriod({ expiryMode: "date", expiryDate: null }, D).known).toBe(false);
    expect(computeServicePeriod({ expiryMode: "date", expiryDate: "27/03/31" }, D).known).toBe(false);
  });
  it("rolling_month: 컷오프 전/후, early-use, 이미 시작된 달", () => {
    const before = computeServicePeriod({ expiryMode: "rolling_month", rollingMonthCutoffDay: 28 }, D);   // 27일 < 28 → 이번 달
    expect(before).toMatchObject({ rawStartDate: "2026-10-01", startDate: D, endDate: "2026-10-31", preBookingDays: 0 });
    expect(describeServicePeriod(before)!.note).toContain("결제일부터");
    const after = computeServicePeriod({ expiryMode: "rolling_month", rollingMonthCutoffDay: 20 }, D);    // 27일 ≥ 20 → 다음 달
    expect(after).toMatchObject({ rawStartDate: "2026-11-01", startDate: "2026-11-01", endDate: "2026-11-30", preBookingDays: 5 });
    const early = computeServicePeriod({ expiryMode: "rolling_month", rollingMonthCutoffDay: 20, rollingMonthAllowEarlyUse: true }, D);
    expect(early).toMatchObject({ rawStartDate: D, startDate: D, endDate: "2026-11-30", preBookingDays: 0 });
  });
  it("정보가 없거나 불충분하면 known=false, 문구도 만들지 않는다", () => {
    for (const src of [null, undefined, { expiryMode: null }, { expiryMode: "days" }, { expiryMode: "days", expiryDays: -1 }, { expiryMode: "rolling_month" }, { expiryMode: "rolling_month", rollingMonthCutoffDay: 0 }, { expiryMode: "rolling_month", rollingMonthCutoffDay: 32 }, { expiryMode: "weird" as never }] as Array<PeriodSource | null | undefined>) {
      const p = computeServicePeriod(src, D); expect(p.known, JSON.stringify(src)).toBe(false); expect(describeServicePeriod(p)).toBeNull(); expect(checkNicepayLimits(p)).toEqual(["unknown"]);
    }
  });
});

describe("NICEPAY 입점 기준(사전예약 ≤ 60일, 서비스 제공기간 ≤ 1년) 분류", () => {
  const D = "2026-10-27";
  const flags = (s: PeriodSource) => checkNicepayLimits(computeServicePeriod(s, D));
  it("기준 충족", () => {
    expect(flags({ expiryMode: "days", expiryDays: 365 })).toEqual(["ok"]);
    expect(flags({ expiryMode: "date", expiryDate: "2027-10-27" })).toEqual(["ok"]);       // 정확히 1년
    expect(flags({ expiryMode: "rolling_month", rollingMonthCutoffDay: 20 })).toEqual(["ok"]);
  });
  it("만료일 없음은 상한을 증명할 수 없어 별도 분류(open_ended)", () => { expect(flags({ expiryMode: "none" })).toEqual(["open_ended"]); });
  it("1년 초과: 일수 366+ · 고정일이 1년 뒤보다 늦음", () => {
    expect(flags({ expiryMode: "days", expiryDays: 366 })).toEqual(["service_over_1y"]);
    expect(flags({ expiryMode: "date", expiryDate: "2027-10-28" })).toEqual(["service_over_1y"]);
    expect(flags({ expiryMode: "days", expiryDays: 730 })).toEqual(["service_over_1y"]);
  });
  it("사전예약 60일 초과는 별도 플래그(현재 서버 규칙으로는 월 갱신형이 최대 약 31일)", () => {
    const p = { ...computeServicePeriod({ expiryMode: "days", expiryDays: 30 }, D), preBookingDays: 61 };
    expect(checkNicepayLimits(p)).toEqual(["prebooking_over_60d"]);
    let max = 0; for (let day = 0; day < 365; day++) for (const cutoff of [1, 15, 31]) { const q = computeServicePeriod({ expiryMode: "rolling_month", rollingMonthCutoffDay: cutoff }, addDays("2026-01-01", day)); max = Math.max(max, q.preBookingDays ?? 0); }
    expect(max).toBeLessThanOrEqual(31);
  });
  it("과거 만료일(이미 끝난 고정일)은 기간이 음수 — 판매 중이면 별도 확인(ok 로 세지 않는다 아님: 기준 위반은 아니지만 span<0 을 노출)", () => {
    const p = computeServicePeriod({ expiryMode: "date", expiryDate: "2026-01-01" }, D);
    expect(p.serviceSpanDays).toBeLessThan(0);
  });
});

describe("고객 문구", () => {
  it("사전예약 없음 / 있음, 서비스 제공기간 형식", () => {
    const d = describeServicePeriod(computeServicePeriod({ expiryMode: "days", expiryDays: 60 }, "2026-10-27"))!;
    expect(d.prebooking).toContain("없음"); expect(d.service).toBe("2026년 10월 27일 ~ 2026년 12월 26일 (결제일로부터 60일)");
    const r = describeServicePeriod(computeServicePeriod({ expiryMode: "rolling_month", rollingMonthCutoffDay: 20 }, "2026-10-27"))!;
    expect(r.prebooking).toBe("결제일(2026년 10월 27일) ~ 이용 시작 전날(2026년 10월 31일) · 5일"); expect(r.service).toContain("매월 갱신형");
    const n = describeServicePeriod(computeServicePeriod({ expiryMode: "none" }, "2026-10-27"))!;
    expect(n.service).toContain("만료일 없음");
  });
  it("공통 안내문은 모든 수강권이 1년 유효하다는 식의 문구를 포함하지 않는다", () => {
    expect(PERIOD_GENERIC_NOTICE).not.toMatch(/1년|365|모든 수강권/);
  });
});

describe("서버 SQL 과 전수 대조(PGlite = 실제 PostgreSQL 엔진)", () => {
  it("calc_rolling_month_dates: 2026-2028 모든 날짜 × 컷오프 1~31 이 JS 와 동일, days 만료도 동일", async () => {
    const src = readFileSync(path.resolve(__dirname, "../../add_rolling_month_product_expiry.sql"), "utf8");
    const fn = src.match(/create or replace function calc_rolling_month_dates[\s\S]*?\$\$;/i)![0];
    const db = new PGlite(); await db.exec(fn);
    const res = await db.query<{ d: string; c: number; s: string; e: string }>(`
      select to_char(d, 'YYYY-MM-DD') as d, c, to_char(r.starts_at, 'YYYY-MM-DD') as s, to_char(r.expires_at, 'YYYY-MM-DD') as e
      from generate_series(date '2026-01-01', date '2028-12-31', interval '1 day') d, generate_series(1, 31) c,
           lateral calc_rolling_month_dates((d::date::text || ' 12:00:00+09')::timestamptz, c) r`);
    expect(res.rows.length).toBe(1096 * 31);
    let bad = 0; for (const r of res.rows) { const js = calcRollingMonthDates(r.d, r.c); if (js.startsAt !== r.s || js.expiresAt !== r.e) bad++; }
    expect(bad).toBe(0);
    // days: ((now() + N days) at time zone 'Asia/Seoul')::date  ==  결제일(KST) + N
    const days = await db.query<{ d: string; n: number; e: string }>(`
      select to_char(d::date, 'YYYY-MM-DD') as d, n, to_char(((d::date::text || ' 12:00:00+09')::timestamptz + (n || ' days')::interval) at time zone 'Asia/Seoul', 'YYYY-MM-DD') as e
      from generate_series(date '2026-01-01', date '2028-12-31', interval '7 day') d, unnest(array[0,1,7,30,90,180,365,366,730]) n`);
    for (const r of days.rows) expect(addDays(r.d, r.n), `${r.d}+${r.n}`).toBe(r.e);
  }, 120_000);
});
