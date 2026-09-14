/*
  내 예약(app/my-reservations/page.tsx) 정책 전면 개정(2026-09-14 릴리스 폴리시 배치)의
  핵심 로직 단위 테스트. classifyReservationDisplay()는 startAt(classes.start_time)과
  현재 시각을 비교해 배지 문구/취소 버튼 노출을 결정한다 — 기존엔 상태(status)만 보고
  시각 비교가 전혀 없어 지난 수업이어도 "예약 확정"/취소 버튼이 계속 보이던 버그가 있었다.

  경계값 요구사항(사용자 지정): startAt > now, startAt == now, startAt < now 모두 확인 —
  startAt <= now면 더 이상 "예정" 상태로 취급하지 않는다.
*/
import { describe, expect, it } from "vitest";
import { classifyReservationDisplay, startAtMs } from "../../app/my-reservations/page";

const NOW = new Date("2026-07-14T20:00:00.000Z").getTime();
const FUTURE = new Date("2026-07-14T20:00:01.000Z").toISOString(); // now보다 1초 미래
const PAST = new Date("2026-07-14T19:59:59.000Z").toISOString(); // now보다 1초 과거
const EXACT_NOW = new Date(NOW).toISOString(); // startAt == now

describe("classifyReservationDisplay", () => {
  it("미래 + confirmed → 예약 확정 배지, 취소 가능(예정된 예약)", () => {
    const r = classifyReservationDisplay({ startAt: FUTURE, status: "confirmed" }, NOW);
    expect(r.isPast).toBe(false);
    expect(r.badgeLabel).toBe("예약 확정");
    expect(r.cancellable).toBe(true);
  });

  it("미래 + waitlisted → 대기 배지, 취소 가능(예정된 예약)", () => {
    const r = classifyReservationDisplay({ startAt: FUTURE, status: "waitlisted" }, NOW);
    expect(r.isPast).toBe(false);
    expect(r.badgeLabel).toBe("대기");
    expect(r.cancellable).toBe(true);
  });

  it("startAt == now → 더 이상 예정이 아니라 지난 예약으로 취급된다(startAt<=now)", () => {
    const r = classifyReservationDisplay({ startAt: EXACT_NOW, status: "confirmed" }, NOW);
    expect(r.isPast).toBe(true);
    expect(r.cancellable).toBe(false);
    // 최종 상태(출석/노쇼/취소)가 아직 없으므로 배지는 새로 지어내지 않고 비운다.
    expect(r.badgeLabel).toBeNull();
  });

  it("과거 + attended → 출석 배지, 취소 버튼 없음(지난 예약)", () => {
    const r = classifyReservationDisplay({ startAt: PAST, status: "attended" }, NOW);
    expect(r.isPast).toBe(true);
    expect(r.badgeLabel).toBe("출석");
    expect(r.cancellable).toBe(false);
  });

  it("과거 + no_show → 노쇼 배지, 취소 버튼 없음(지난 예약)", () => {
    const r = classifyReservationDisplay({ startAt: PAST, status: "no_show" }, NOW);
    expect(r.isPast).toBe(true);
    expect(r.badgeLabel).toBe("노쇼");
    expect(r.cancellable).toBe(false);
  });

  it("과거 + cancelled → 취소 배지, 취소 버튼 없음(지난 예약)", () => {
    const r = classifyReservationDisplay({ startAt: PAST, status: "cancelled" }, NOW);
    expect(r.isPast).toBe(true);
    expect(r.badgeLabel).toBe("취소");
    expect(r.cancellable).toBe(false);
  });

  it("미래 + cancelled → 시각이 안 지났어도 취소 건은 무조건 지난 예약으로 취급된다(사용자 피드백)", () => {
    const r = classifyReservationDisplay({ startAt: FUTURE, status: "cancelled" }, NOW);
    expect(r.isPast).toBe(true);
    expect(r.badgeLabel).toBe("취소");
    expect(r.cancellable).toBe(false);
  });

  it("과거인데 아직 출석 처리 전(confirmed)이면 '예약 확정'을 보여주지 않고 배지 없이 비운다 — 새 상태를 지어내지 않는다", () => {
    const r = classifyReservationDisplay({ startAt: PAST, status: "confirmed" }, NOW);
    expect(r.isPast).toBe(true);
    expect(r.badgeLabel).toBeNull();
    expect(r.cancellable).toBe(false);
  });

  it("과거인데 아직 최종 처리 전(waitlisted)이면 '대기'를 보여주지 않고 배지 없이 비운다 — 취소 버튼도 없음", () => {
    const r = classifyReservationDisplay({ startAt: PAST, status: "waitlisted" }, NOW);
    expect(r.isPast).toBe(true);
    expect(r.badgeLabel).toBeNull();
    expect(r.cancellable).toBe(false);
  });

  it("startAt을 알 수 없으면(연결된 수업 삭제 등) 미래/과거 어느 쪽으로도 강제 분류하지 않는다", () => {
    const r = classifyReservationDisplay({ startAt: null, status: "confirmed" }, NOW);
    expect(r.isPast).toBe(false);
    expect(startAtMs({ startAt: null })).toBeNull();
  });
});
