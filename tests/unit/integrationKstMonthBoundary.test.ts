/*
  Issue #277 — 통합 테스트의 수업 생성 시각·조회 대상 월 계산이 UTC/KST 월 경계에서 어긋나던 문제의 결정적 검증.
  현재 시각은 now 인자로 주입(모의 시계)하고, 머신 시간대에 의존하지 않는다(CI=UTC, 로컬=KST 모두 같은 결과).
  기대값은 helper 와 독립인 Intl.DateTimeFormat(Asia/Seoul) 로 계산한다.
*/
import { describe, expect, it } from "vitest";
import { kstMidMonthFuture, kstYearMonth } from "../helpers/kstMonth";
import { getKstMonthUtcRange } from "../../lib/kst";

const KST_PARTS = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" });
function kstParts(d: Date) { const p = Object.fromEntries(KST_PARTS.formatToParts(d).map((x) => [x.type, x.value])); return { year: Number(p.year), month: Number(p.month), day: Number(p.day), hour: Number(p.hour) }; }

describe("kstYearMonth — 머신 시간대와 무관한 KST 연/월", () => {
  it.each([
    ["2026-12-31T14:59:59Z", 2026, 12],   // 12/31 23:59:59 KST
    ["2026-12-31T15:00:00Z", 2027, 1],    // 1/1 00:00 KST — UTC 는 아직 12월
    ["2026-12-31T18:19:09Z", 2027, 1],    // Issue #277 CI 실패 시각대(+905h 수업)
    ["2027-02-28T14:59:59Z", 2027, 2],
    ["2027-02-28T15:00:00Z", 2027, 3],    // 비윤년 2월 말
    ["2028-02-29T14:59:59Z", 2028, 2],
    ["2028-02-29T15:00:00Z", 2028, 3],    // 윤년 2월 29일
    ["2026-04-30T15:00:00Z", 2026, 5],    // 30일 월말
    ["2026-01-31T15:00:00Z", 2026, 2],    // 31일 월말
  ])("%s → KST %i-%i", (iso, y, m) => { expect(kstYearMonth(new Date(iso))).toEqual({ year: y, month: m }); });
});

describe("kstMidMonthFuture — 다음 달 15일 12:00 KST", () => {
  it.each([
    ["월 중간(일반)", "2026-11-10T03:00:00Z", "2026-12-15T12:00:00+09:00"],
    ["Issue #277 CI 실패 시각(2026-11-24T01:19:09Z)", "2026-11-24T01:19:09Z", "2026-12-15T12:00:00+09:00"],
    ["12월 → 다음 해 1월(연도 변경)", "2026-12-20T00:00:00Z", "2027-01-15T12:00:00+09:00"],
    ["UTC 12/31 · KST 1/1 경계 직후", "2026-12-31T15:00:00Z", "2027-02-15T12:00:00+09:00"],
    ["UTC 12/31 · KST 12/31 경계 직전", "2026-12-31T14:59:59Z", "2027-01-15T12:00:00+09:00"],
    ["31일 월말(KST 이미 다음 달)", "2026-01-31T15:00:00Z", "2026-03-15T12:00:00+09:00"],
    ["비윤년 2월 말", "2027-02-28T10:00:00Z", "2027-03-15T12:00:00+09:00"],
    ["윤년 2월 29일", "2028-02-29T10:00:00Z", "2028-03-15T12:00:00+09:00"],
    ["30일 월말", "2026-04-30T10:00:00Z", "2026-05-15T12:00:00+09:00"],
  ])("%s", (_n, now, expected) => { expect(kstMidMonthFuture(new Date(now)).toISOString()).toBe(new Date(expected).toISOString()); });

  it("monthsAhead=2·12 도 월·연도 올림이 맞다", () => {
    expect(kstMidMonthFuture(new Date("2026-11-24T01:19:09Z"), 2).toISOString()).toBe(new Date("2027-01-15T12:00:00+09:00").toISOString());
    expect(kstMidMonthFuture(new Date("2026-11-24T01:19:09Z"), 12).toISOString()).toBe(new Date("2027-11-15T12:00:00+09:00").toISOString());
  });
});

describe("회귀 재현 — 고정 오프셋 + 러너(UTC) 월 계산은 월 경계에서 앱 조회 월과 어긋난다", () => {
  const failingNow = new Date("2026-11-24T01:19:09Z");   // Issue #277 CI 실패 시각
  it("기존 방식(now+905h, UTC 월)은 앱의 KST 월 범위에 포함되지 않는다(= 수업이 조회되지 않음)", () => {
    const start = new Date(failingNow.getTime() + 905 * 3600 * 1000);
    const legacyYear = start.getUTCFullYear(), legacyMonth = start.getUTCMonth() + 1;   // 러너 시간대가 UTC 일 때의 getFullYear()/getMonth()+1
    expect([legacyYear, legacyMonth]).toEqual([2026, 12]);
    expect(kstYearMonth(start)).toEqual({ year: 2027, month: 1 });
    const { startUtcIso, endUtcIso } = getKstMonthUtcRange(legacyYear, legacyMonth);
    expect(start.toISOString() >= startUtcIso && start.toISOString() < endUtcIso).toBe(false);
  });
  it("수정 방식은 같은 시각에서 수업이 앱이 조회하는 KST 월 범위 안에 있다", () => {
    const start = kstMidMonthFuture(failingNow);
    const { year, month } = kstYearMonth(start);
    const { startUtcIso, endUtcIso } = getKstMonthUtcRange(year, month);
    expect(start.toISOString() >= startUtcIso && start.toISOString() < endUtcIso).toBe(true);
  });
});

describe("전수 검증 — 2026~2029년 매시간 실행 시각 모두에서 수업이 항상 (미래 · 앱의 KST 월 범위 안 · 월 중간)", () => {
  it("모든 now 에서 불변식 성립", () => {
    const from = Date.UTC(2026, 0, 1), to = Date.UTC(2030, 0, 1);
    let checked = 0;
    for (let t = from; t < to; t += 3600 * 1000) {
      const now = new Date(t);
      const start = kstMidMonthFuture(now);
      const { year, month } = kstYearMonth(start);
      const { startUtcIso, endUtcIso } = getKstMonthUtcRange(year, month);
      const iso = start.toISOString();
      if (!(start.getTime() - t >= 13 * 24 * 3600 * 1000)) throw new Error(`미래가 아님/너무 가까움: now=${now.toISOString()}`);
      if (!(iso >= startUtcIso && iso < endUtcIso)) throw new Error(`KST 월 범위 밖: now=${now.toISOString()}`);
      const kp = kstParts(start);
      if (kp.day !== 15 || kp.hour !== 12 || kp.year !== year || kp.month !== month) throw new Error(`KST 15일 12시 아님: now=${now.toISOString()} → ${JSON.stringify(kp)}`);
      const nowK = kstParts(now), expectedMonth = nowK.month === 12 ? 1 : nowK.month + 1, expectedYear = nowK.month === 12 ? nowK.year + 1 : nowK.year;
      if (kp.month !== expectedMonth || kp.year !== expectedYear) throw new Error(`다음 달이 아님: now=${now.toISOString()}`);
      checked++;
    }
    expect(checked).toBe((to - from) / 3600000);
  });
});
