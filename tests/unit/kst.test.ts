/*
  KST 월 경계 → UTC ISO 변환 단위 테스트(lib/kst.ts). "수강권 구매 직후 예약 캘린더에
  일부 수업만 보인다" 버그의 근본 원인(fetchMonthData의 monthStart/nextMonth가 타임존
  표기 없는 문자열이라 UTC로 해석되던 것)을 수정하며 뽑아낸 공용 유틸을 검증한다.

  new Date(year, month, day) 같은 "로컬 머신 타임존 의존" 생성자를 전혀 쓰지 않고
  toKstIso()(+09:00 명시) → toISOString()(항상 UTC)만 쓰므로, 이 테스트는 실행 환경의
  타임존(맥 로컬/GitHub Actions UTC/Vercel)과 무관하게 항상 같은 결과가 나와야 한다.
*/
import { describe, expect, it } from "vitest";
import { getKstMonthUtcRange, toKstIso } from "../../lib/kst";

describe("toKstIso", () => {
  it("날짜+시간을 +09:00 오프셋 ISO 문자열로 만든다", () => {
    expect(toKstIso("2026-10-01", "00:00")).toBe("2026-10-01T00:00:00+09:00");
  });
});

describe("getKstMonthUtcRange", () => {
  it("일반 월(2026년 10월): KST 10/1 00:00 -> UTC 9/30 15:00, KST 11/1 00:00 -> UTC 10/31 15:00", () => {
    const { startUtcIso, endUtcIso } = getKstMonthUtcRange(2026, 10);
    expect(startUtcIso).toBe("2026-09-30T15:00:00.000Z");
    expect(endUtcIso).toBe("2026-10-31T15:00:00.000Z");
  });

  it("12월 -> 다음 해 1월 연도 전환", () => {
    const { startUtcIso, endUtcIso } = getKstMonthUtcRange(2026, 12);
    expect(startUtcIso).toBe("2026-11-30T15:00:00.000Z"); // KST 2026-12-01 00:00
    expect(endUtcIso).toBe("2026-12-31T15:00:00.000Z");   // KST 2027-01-01 00:00
  });

  it("윤년 2월(2028년): 3월 1일로의 전환이 정확하다(2월 29일 존재)", () => {
    const { startUtcIso, endUtcIso } = getKstMonthUtcRange(2028, 2);
    expect(startUtcIso).toBe("2028-01-31T15:00:00.000Z"); // KST 2028-02-01 00:00
    expect(endUtcIso).toBe("2028-02-29T15:00:00.000Z");   // KST 2028-03-01 00:00 (윤년 다음날)
  });

  it("비윤년 2월(2026년): 3월 1일로의 전환이 정확하다(2월 28일까지)", () => {
    const { startUtcIso, endUtcIso } = getKstMonthUtcRange(2026, 2);
    expect(startUtcIso).toBe("2026-01-31T15:00:00.000Z"); // KST 2026-02-01 00:00
    expect(endUtcIso).toBe("2026-02-28T15:00:00.000Z");   // KST 2026-03-01 00:00
  });

  it("1월(전달이 작년 12월인 경우)도 정상 계산된다", () => {
    const { startUtcIso, endUtcIso } = getKstMonthUtcRange(2026, 1);
    expect(startUtcIso).toBe("2025-12-31T15:00:00.000Z"); // KST 2026-01-01 00:00
    expect(endUtcIso).toBe("2026-01-31T15:00:00.000Z");   // KST 2026-02-01 00:00
  });
});
