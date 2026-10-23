import { describe, expect, it } from "vitest";
import { futureAttendanceMessage, isClassNotStarted } from "../../lib/attendanceGuard";

describe("미래 수업 출결 확인", () => {
  const now = new Date("2026-10-22T10:00:00+09:00");
  it("시작 전 수업은 true, 시작 시각 이후는 false(KST 기준)", () => {
    expect(isClassNotStarted("2026-10-22", "10:30", now)).toBe(true);
    expect(isClassNotStarted("2026-10-22", "10:00", now)).toBe(false);
    expect(isClassNotStarted("2026-10-21", "23:00", now)).toBe(false);
    expect(isClassNotStarted("2026-10-23", "00:10", now)).toBe(true);
  });
  it("UTC 자정 근처에서도 KST 날짜로 판정한다", () => {
    expect(isClassNotStarted("2026-10-23", "08:00", new Date("2026-10-22T23:30:00Z"))).toBe(false);
    expect(isClassNotStarted("2026-10-23", "09:00", new Date("2026-10-22T23:30:00Z"))).toBe(true);
  });
  it("잘못된 입력은 확인창을 띄우지 않는다", () => { expect(isClassNotStarted("", "", now)).toBe(false); });
  it("문구", () => { expect(futureAttendanceMessage("홍길동", "no_show")).toContain("결석(노쇼)"); });
});
