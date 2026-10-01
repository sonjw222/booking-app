/*
  lib/passes.ts — computeSelectableSchedule() (Batch C, C-4/C-5). "구매 시 요일/시간
  선택" 후보를 기존 membership_schedule_rules(예약조건)에서 계산한다 — 새 스케줄
  데이터를 만들지 않고 기존 테이블을 재사용한다는 설계의 핵심 함수라 순수 함수로
  직접 검증한다.
*/
import { describe, expect, it } from "vitest";
import { computeSelectableSchedule, type ScheduleRule } from "../../lib/passes";

function rule(dayOfWeek: number | null, startTime: string | null, classTitle: string | null = null): ScheduleRule {
  return { id: "r", dayOfWeek, startTime, classTitle };
}

describe("computeSelectableSchedule()", () => {
  it("요일이 지정된 규칙에서 요일/시간 후보를 뽑는다", () => {
    const rules = [rule(1, "16:00"), rule(1, "20:00"), rule(3, "16:00")];
    const result = computeSelectableSchedule(rules);
    expect(result.days).toEqual([1, 3]);
    expect(result.timesByDay).toEqual({ 1: ["16:00", "20:00"], 3: ["16:00"] });
  });

  it("dayOfWeek가 null인 규칙('모든 요일')은 후보에서 제외한다", () => {
    const result = computeSelectableSchedule([rule(null, "19:00"), rule(1, "16:00")]);
    expect(result.days).toEqual([1]);
  });

  it("startTime이 null인 규칙(그 요일은 시간 무관 전체 허용)은 요일만 후보에 넣고 시간은 비워둔다", () => {
    const result = computeSelectableSchedule([rule(2, null)]);
    expect(result.days).toEqual([2]);
    expect(result.timesByDay[2]).toEqual([]);
  });

  it("규칙이 없으면 빈 후보(요일 선택 UI 자체가 안 뜨는 상태)", () => {
    expect(computeSelectableSchedule([])).toEqual({ days: [], timesByDay: {} });
  });

  it("같은 요일에 같은 시간이 중복 등록돼도 한 번만 나온다", () => {
    const result = computeSelectableSchedule([rule(1, "16:00"), rule(1, "16:00")]);
    expect(result.timesByDay[1]).toEqual(["16:00"]);
  });

  it("요일은 오름차순, 시간은 문자열 정렬로 반환한다(화면 표시 순서 안정성)", () => {
    const result = computeSelectableSchedule([rule(5, "20:00"), rule(1, "16:00"), rule(5, "10:00")]);
    expect(result.days).toEqual([1, 5]);
    expect(result.timesByDay[5]).toEqual(["10:00", "20:00"]);
  });
});
