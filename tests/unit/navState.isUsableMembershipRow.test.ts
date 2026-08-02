/*
  lib/navState.ts의 isUsableMembershipRow 순수 predicate 단위 테스트(NAV-001).
  하단 Navigation의 "예약" 탭 표시 여부를 결정하는 핵심 조건 — remaining_count가 null(무제한권)
  이거나 1 이상이면 usable로 간주한다. status='active'/expires_at>=today는 이 함수 호출 전에
  쿼리 단계에서 이미 필터링되므로 여기서는 remaining_count만 검증한다.
*/
import { describe, expect, it } from "vitest";
import { isUsableMembershipRow } from "../../lib/navState";

describe("isUsableMembershipRow", () => {
  it("remaining_count가 null이면(무제한권) usable이다", () => {
    expect(isUsableMembershipRow({ remaining_count: null })).toBe(true);
  });
  it("remaining_count가 1 이상이면 usable이다", () => {
    expect(isUsableMembershipRow({ remaining_count: 1 })).toBe(true);
    expect(isUsableMembershipRow({ remaining_count: 10 })).toBe(true);
  });
  it("remaining_count가 0이면 usable이 아니다(횟수 소진)", () => {
    expect(isUsableMembershipRow({ remaining_count: 0 })).toBe(false);
  });
});
