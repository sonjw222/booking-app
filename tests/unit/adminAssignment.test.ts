/*
  lib/adminAssignment.ts의 isRevertEligible() 순수 로직 단위 테스트. Supabase 접속 불필요.
*/
import { describe, expect, it } from "vitest";
import { isRevertEligible } from "../../lib/adminAssignment";

const FUTURE = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
const PAST = new Date(Date.now() - 24 * 3600 * 1000).toISOString();

function log(overrides: Partial<Parameters<typeof isRevertEligible>[0]> = {}) {
  return {
    actionType: "CREATE_ASSIGNMENT" as const,
    reservationId: "11111111-1111-1111-1111-111111111111",
    currentReservationStatus: "confirmed",
    classStart: FUTURE,
    ...overrides,
  };
}

describe("isRevertEligible", () => {
  it("CREATE_ASSIGNMENT + 활성 예약 + 미래 수업이면 되돌릴 수 있다", () => {
    expect(isRevertEligible(log())).toBe(true);
  });

  it("CREATE_FREE도 동일 조건이면 되돌릴 수 있다", () => {
    expect(isRevertEligible(log({ actionType: "CREATE_FREE" }))).toBe(true);
  });

  it("CANCEL_ASSIGNMENT/CANCEL_FREE(취소 로그 자체)는 되돌릴 수 없다", () => {
    expect(isRevertEligible(log({ actionType: "CANCEL_ASSIGNMENT" }))).toBe(false);
    expect(isRevertEligible(log({ actionType: "CANCEL_FREE" }))).toBe(false);
  });

  it("reservationId가 없으면(향후 비예약 액션) 되돌릴 수 없다", () => {
    expect(isRevertEligible(log({ reservationId: null }))).toBe(false);
  });

  it("이미 취소된 예약이면 되돌릴 수 없다", () => {
    expect(isRevertEligible(log({ currentReservationStatus: "cancelled" }))).toBe(false);
  });

  it("수업이 이미 시작/종료됐으면(과거) 되돌릴 수 없다", () => {
    expect(isRevertEligible(log({ classStart: PAST }))).toBe(false);
  });

  it("classStart가 없으면 되돌릴 수 없다", () => {
    expect(isRevertEligible(log({ classStart: null }))).toBe(false);
  });

  it("출석/노쇼로 바뀐 예약이어도(취소만 아니면) 되돌릴 수 있다 — 수업 시작 전이라면", () => {
    // manager_set_attendance로 출석 처리된 경우도 admin_cancel_reservation 자체는 막지 않으므로
    // (서버는 status='cancelled'만 막음) 클라이언트 판정도 동일 기준을 따른다.
    expect(isRevertEligible(log({ currentReservationStatus: "attended" }))).toBe(true);
  });
});
