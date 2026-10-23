import { describe, expect, it } from "vitest";
import { bookingHint } from "../../lib/bookingHints";

const base = { full: false, classFormat: "group" as const, waitlistWeeklyLimit: 2, allowSameDayBooking: true, bookingDeadlineMin: null, classDate: "2026-10-23", todayKst: "2026-10-23" };
describe("F10 — 예약/대기 불가 안내(서버가 같은 입력으로 거절하는 경우만)", () => {
  it("정상 예약 가능한 수업은 안내 없음", () => expect(bookingHint(base)).toBeNull());
  it("정원 마감 + 대기 횟수 0 → 대기 불가, 횟수가 있으면 안내 없음(주간 횟수는 서버 판정)", () => {
    expect(bookingHint({ ...base, full: true, waitlistWeeklyLimit: 0 })?.kind).toBe("no_waitlist");
    expect(bookingHint({ ...base, full: true, waitlistWeeklyLimit: 3 })).toBeNull();
  });
  it("설정을 읽지 못하면(모름) 대기 불가로 단정하지 않는다", () => {
    expect(bookingHint({ ...base, full: true, waitlistWeeklyLimit: null })).toBeNull();
    expect(bookingHint({ ...base, full: true, waitlistWeeklyLimit: undefined })).toBeNull();
  });
  it("프라이빗 마감은 대기 없음", () => expect(bookingHint({ ...base, full: true, classFormat: "private", waitlistWeeklyLimit: 5 })?.kind).toBe("private_full"));
  it("당일 예약 OFF: 오늘 수업만, 개별 예약마감이 있으면 건너뜀, 다른 날은 안내 없음, 모름이면 안내 없음", () => {
    expect(bookingHint({ ...base, allowSameDayBooking: false })?.kind).toBe("same_day_off");
    expect(bookingHint({ ...base, allowSameDayBooking: false, bookingDeadlineMin: 30 })).toBeNull();
    expect(bookingHint({ ...base, allowSameDayBooking: false, classDate: "2026-10-24" })).toBeNull();
    expect(bookingHint({ ...base, allowSameDayBooking: null })).toBeNull();
  });
});
