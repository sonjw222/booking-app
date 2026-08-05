/*
  RES-001 C-5(10분 취소 예외) "취소 가능 시각 계산" 단위 테스트(섹션 4 재검증).
  cancel_reservation() SQL의 grace/effective deadline 공식을 그대로 미러링한
  lib/cancelDeadline.ts를 검증한다. 사용자가 든 예시(20:00 수업, 19:55 예약)를 그대로 사용.
*/
import { describe, expect, it } from "vitest";
import { computeEffectiveCancelDeadline, isCancellable } from "../../lib/cancelDeadline";

const classStart = new Date("2026-01-01T20:00:00+09:00");
const centerDeadlineFarPast = new Date("2025-12-31T22:00:00+09:00"); // 일반 취소마감(예: 1일 전) — 이미 지남

describe("computeEffectiveCancelDeadline", () => {
  it("19:30 예약 → 10분 그대로 19:40이 유효 마감이다", () => {
    const createdAt = new Date("2026-01-01T19:30:00+09:00");
    const effective = computeEffectiveCancelDeadline(centerDeadlineFarPast, createdAt, classStart);
    expect(effective.toISOString()).toBe(new Date("2026-01-01T19:40:00+09:00").toISOString());
  });

  it("19:55 예약(수업 5분 전) → 10분이 아니라 수업 시작 시각(20:00)으로 clamp된다", () => {
    const createdAt = new Date("2026-01-01T19:55:00+09:00");
    const effective = computeEffectiveCancelDeadline(centerDeadlineFarPast, createdAt, classStart);
    expect(effective.toISOString()).toBe(classStart.toISOString());
  });

  it("센터의 일반 취소마감이 10분 예외보다 더 관대하면(늦으면) 그 마감을 그대로 쓴다", () => {
    const createdAt = new Date("2026-01-01T19:30:00+09:00"); // grace=19:40
    const generousDeadline = new Date("2026-01-01T19:50:00+09:00"); // 더 늦음
    const effective = computeEffectiveCancelDeadline(generousDeadline, createdAt, classStart);
    expect(effective.toISOString()).toBe(generousDeadline.toISOString());
  });
});

describe("isCancellable", () => {
  it("정확히 10분 경계(now === effective)에는 취소 가능하다", () => {
    const createdAt = new Date("2026-01-01T19:30:00+09:00");
    const now = new Date("2026-01-01T19:40:00+09:00");
    expect(isCancellable(now, centerDeadlineFarPast, createdAt, classStart)).toBe(true);
  });

  it("10분을 1ms라도 넘고 일반 마감도 지났으면 취소 불가하다", () => {
    const createdAt = new Date("2026-01-01T19:30:00+09:00");
    const now = new Date("2026-01-01T19:40:00.001+09:00");
    expect(isCancellable(now, centerDeadlineFarPast, createdAt, classStart)).toBe(false);
  });

  it("수업 시작 이후에는 10분 이내에 예약했어도 절대 취소 불가하다", () => {
    const createdAt = new Date("2026-01-01T19:59:59+09:00"); // grace would be 20:00(clamp)
    const now = new Date("2026-01-01T20:00:00+09:00"); // 수업 시작과 동시 → 시작으로 간주, 불가
    expect(isCancellable(now, centerDeadlineFarPast, createdAt, classStart)).toBe(false);
  });

  it("수업 시작 훨씬 전, 일반 마감도 안 지났고 10분도 안 지났으면 취소 가능하다", () => {
    const createdAt = new Date("2026-01-01T10:00:00+09:00");
    const now = new Date("2026-01-01T10:05:00+09:00");
    const generousDeadline = new Date("2026-01-01T19:00:00+09:00");
    expect(isCancellable(now, generousDeadline, createdAt, classStart)).toBe(true);
  });
});
