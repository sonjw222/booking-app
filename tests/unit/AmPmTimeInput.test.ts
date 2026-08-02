// @vitest-environment jsdom
/*
  app/components/AmPmTimeInput.tsx 순수 변환 로직(parse24h/to24h) 단위 테스트(UI-004 B-2).
  Supabase 접속 필요 없음 — 브라우저 렌더링 없이 12h↔24h 변환 규칙만 검증한다.
*/
import { describe, expect, it } from "vitest";
import { parse24h, to24h } from "../../app/components/AmPmTimeInput";

describe("parse24h", () => {
  it("오전 시간을 정확히 파싱한다", () => {
    expect(parse24h("07:10")).toEqual({ period: "AM", hour12: 7, minute: 10 });
  });
  it("오후 시간을 정확히 파싱한다", () => {
    expect(parse24h("19:30")).toEqual({ period: "PM", hour12: 7, minute: 30 });
  });
  it("자정(00:00)은 오전 12시로 파싱한다", () => {
    expect(parse24h("00:00")).toEqual({ period: "AM", hour12: 12, minute: 0 });
  });
  it("정오(12:00)는 오후 12시로 파싱한다", () => {
    expect(parse24h("12:00")).toEqual({ period: "PM", hour12: 12, minute: 0 });
  });
  it("빈 값/잘못된 형식은 00:00(오전 12시)으로 안전하게 처리한다", () => {
    expect(parse24h("")).toEqual({ period: "AM", hour12: 12, minute: 0 });
    expect(parse24h("garbage")).toEqual({ period: "AM", hour12: 12, minute: 0 });
  });
});

describe("to24h", () => {
  it("오전 시각을 그대로 24시간제로 변환한다", () => {
    expect(to24h("AM", 7, 10)).toBe("07:10");
  });
  it("오후 시각은 12를 더한다", () => {
    expect(to24h("PM", 7, 30)).toBe("19:30");
  });
  it("오전 12시(자정)는 00시로 변환한다(12를 그대로 쓰지 않음)", () => {
    expect(to24h("AM", 12, 0)).toBe("00:00");
  });
  it("오후 12시(정오)는 12시 그대로 유지한다(24시가 되지 않음)", () => {
    expect(to24h("PM", 12, 0)).toBe("12:00");
  });
  it("분은 항상 2자리로 패딩한다(분 기본값 0 → '00')", () => {
    expect(to24h("AM", 9, 0)).toBe("09:00");
  });
});

describe("parse24h ↔ to24h round-trip", () => {
  it("어떤 유효한 24시간제 값도 왕복 변환 후 동일하다", () => {
    for (const time of ["00:00", "00:59", "11:59", "12:00", "13:05", "23:59"]) {
      const { period, hour12, minute } = parse24h(time);
      expect(to24h(period, hour12, minute)).toBe(time);
    }
  });
});
