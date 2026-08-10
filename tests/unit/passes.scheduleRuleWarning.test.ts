/*
  lib/passes.ts의 matchesAnyScheduleRule/findScheduleExcludedProducts 순수 함수 단위 테스트
  (P1-15). 실제 QA에서 재현된 버그: "모든 수강권 허용"으로 신규 수업을 만들어도, 그 회원이
  가진 pass 상품 자체에 membership_schedule_rules(요일/시간/수업명 조건)가 걸려 있으면
  usable_memberships_for_classes() RPC가 그 조건과 안 맞는 수업에서는 그 pass를 제외한다 —
  class_allowed_products("어떤 상품을 쓸 수 있는지")와 membership_schedule_rules("그 상품을
  어느 수업에 쓸 수 있는지")는 서로 독립적인 AND 조건이다. 이 로직은 usable_memberships_for_classes
  RPC의 판정과 정확히 동일해야 하므로(fix_usable_memberships_product_kind.sql 참고), 그
  SQL을 그대로 옮긴 것 — RPC를 바꾸지 않고 관리자 UI 쪽 경고 계산에만 재사용한다.
*/
import { describe, expect, it } from "vitest";
import { matchesAnyScheduleRule, findScheduleExcludedProducts, type ScheduleRule } from "../../lib/passes";

const mon2100 = { dayOfWeek: 1, startTime: "21:00", classTitle: "테스트" };
const tue1600 = { dayOfWeek: 2, startTime: "16:00", classTitle: "수업" };

describe("matchesAnyScheduleRule", () => {
  it("A. 규칙이 없으면 항상 허용된다(모든 수강권 허용 + 규칙 없는 pass)", () => {
    expect(matchesAnyScheduleRule([], mon2100)).toBe(true);
  });

  it("B. 규칙이 있고 요일/시간/수업명이 전부 일치하면 허용된다", () => {
    const rule: ScheduleRule = { id: "r1", dayOfWeek: 2, startTime: "16:00", classTitle: "수업" };
    expect(matchesAnyScheduleRule([rule], tue1600)).toBe(true);
  });

  it("C. 규칙이 있고 요일/시간/수업명 중 하나라도 안 맞으면 거부된다(실제 QA 재현 조건)", () => {
    const rule: ScheduleRule = { id: "r1", dayOfWeek: 2, startTime: "16:00", classTitle: "수업" };
    expect(matchesAnyScheduleRule([rule], mon2100)).toBe(false);
  });

  it("규칙의 null 필드는 '모든 값 허용'을 의미한다", () => {
    const anyDay: ScheduleRule = { id: "r1", dayOfWeek: null, startTime: "16:00", classTitle: "수업" };
    expect(matchesAnyScheduleRule([anyDay], { dayOfWeek: 5, startTime: "16:00", classTitle: "수업" })).toBe(true);
    const anyTitle: ScheduleRule = { id: "r2", dayOfWeek: 2, startTime: "16:00", classTitle: null };
    expect(matchesAnyScheduleRule([anyTitle], { dayOfWeek: 2, startTime: "16:00", classTitle: "아무거나" })).toBe(true);
  });

  it("규칙이 여러 개면 하나라도 매치하면 허용된다(OR)", () => {
    const rules: ScheduleRule[] = [
      { id: "r1", dayOfWeek: 2, startTime: "16:00", classTitle: "수업" },
      { id: "r2", dayOfWeek: 3, startTime: "15:00", classTitle: "수업" },
    ];
    expect(matchesAnyScheduleRule(rules, { dayOfWeek: 3, startTime: "15:00", classTitle: "수업" })).toBe(true);
    expect(matchesAnyScheduleRule(rules, mon2100)).toBe(false);
  });
});

describe("findScheduleExcludedProducts", () => {
  it("A. 규칙 없는 상품은 제외 목록에 안 들어간다", () => {
    const excluded = findScheduleExcludedProducts(
      [{ id: "p1", name: "자유이용권" }],
      {},
      mon2100
    );
    expect(excluded).toEqual([]);
  });

  it("B. 규칙과 수업이 일치하는 상품도 제외 목록에 안 들어간다", () => {
    const excluded = findScheduleExcludedProducts(
      [{ id: "p1", name: "화요일반" }],
      { p1: [{ id: "r1", dayOfWeek: 2, startTime: "16:00", classTitle: "수업" }] },
      tue1600
    );
    expect(excluded).toEqual([]);
  });

  it("C. 규칙과 안 맞는 상품은 제외 목록에 들어가고 이유(규칙 원문)를 포함한다", () => {
    const rule: ScheduleRule = { id: "r1", dayOfWeek: 2, startTime: "16:00", classTitle: "수업" };
    const excluded = findScheduleExcludedProducts(
      [{ id: "p1", name: "수강권" }],
      { p1: [rule] },
      mon2100
    );
    expect(excluded).toHaveLength(1);
    expect(excluded[0]).toMatchObject({ productId: "p1", productName: "수강권", rules: [rule] });
  });

  it("F. class_allowed_products로 이미 좁혀진 candidates 중에서도 schedule_rules 불일치는 그대로 걸러진다", () => {
    // "특정 pass 지정"으로 p1만 허용했더라도(candidates가 p1 하나뿐), p1 자체의 schedule_rules와
    // 안 맞으면 여전히 실제로는 쓸 수 없다 — class_allowed_products와 membership_schedule_rules는
    // 독립적인 AND 조건.
    const rule: ScheduleRule = { id: "r1", dayOfWeek: 2, startTime: "16:00", classTitle: "수업" };
    const excluded = findScheduleExcludedProducts(
      [{ id: "p1", name: "지정된수강권" }],
      { p1: [rule] },
      mon2100
    );
    expect(excluded).toHaveLength(1);
  });

  it("여러 상품 중 매치 안 되는 것만 골라낸다", () => {
    const excluded = findScheduleExcludedProducts(
      [{ id: "free", name: "자유이용권" }, { id: "tue", name: "화요일반" }],
      {
        tue: [{ id: "r1", dayOfWeek: 2, startTime: "16:00", classTitle: "수업" }],
        // free는 규칙 없음
      },
      mon2100
    );
    expect(excluded.map((e) => e.productId)).toEqual(["tue"]);
  });
});
