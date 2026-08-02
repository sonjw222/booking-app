/*
  lib/deadlineInput.ts 순수 로직 단위 테스트(CLASS-001). 예약마감/취소마감 입력칸의
  "N일 N시간 N분" ↔ 분(minutes) 변환과 "모두 비면 운영설정 기본값 사용(null)" 규칙을 검증한다.
*/
import { describe, expect, it } from "vitest";
import { dhmToMinutes, minutesToDhm } from "../../lib/deadlineInput";

describe("dhmToMinutes", () => {
  it("세 칸이 모두 비어 있으면 null(운영설정 기본값 사용)을 반환한다", () => {
    expect(dhmToMinutes("", "", "")).toBeNull();
  });
  it("일/시간/분을 분 단위로 정확히 합산한다", () => {
    expect(dhmToMinutes("1", "2", "30")).toBe(1 * 1440 + 2 * 60 + 30);
  });
  it("일부 칸만 채워도 나머지는 0으로 계산한다", () => {
    expect(dhmToMinutes("", "1", "")).toBe(60);
    expect(dhmToMinutes("", "", "30")).toBe(30);
  });
  it("숫자가 아닌 값은 0으로 처리한다", () => {
    expect(dhmToMinutes("abc", "1", "")).toBe(60);
  });
});

describe("minutesToDhm", () => {
  it("null이면 세 칸 모두 빈 문자열이다", () => {
    expect(minutesToDhm(null)).toEqual({ d: "", h: "", m: "" });
  });
  it("0 이하이면 세 칸 모두 빈 문자열이다(운영설정 기본값 사용으로 취급)", () => {
    expect(minutesToDhm(0)).toEqual({ d: "", h: "", m: "" });
  });
  it("분을 일/시간/분으로 정확히 분해한다", () => {
    expect(minutesToDhm(1 * 1440 + 2 * 60 + 30)).toEqual({ d: "1", h: "2", m: "30" });
  });
  it("60분은 1시간 0분으로 분해된다(분 칸은 0이라 빈 문자열)", () => {
    expect(minutesToDhm(60)).toEqual({ d: "", h: "1", m: "" });
  });
});

describe("dhmToMinutes ↔ minutesToDhm round-trip", () => {
  it("null이 아닌 값은 왕복 변환 후 동일한 총 분수를 유지한다", () => {
    for (const min of [1, 30, 60, 90, 1440, 1500, 2000]) {
      const { d, h, m } = minutesToDhm(min);
      expect(dhmToMinutes(d, h, m)).toBe(min);
    }
  });
});
