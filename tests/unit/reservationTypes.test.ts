/*
  lib/reservationTypes.ts 순수 로직 단위 테스트. Supabase 접속이 필요 없음.
*/
import { describe, expect, it } from "vitest";
import {
  normalizeReasonDetail,
  isReasonDetailRequired,
  memberFacingBadge,
  adminBadges,
  RESERVATION_TYPES,
  RESERVATION_SOURCES,
  ADMIN_REASON_CODES,
} from "../../lib/reservationTypes";

describe("normalizeReasonDetail", () => {
  it("앞뒤 공백을 정리한다", () => {
    expect(normalizeReasonDetail("  회원이 요청함  ")).toBe("회원이 요청함");
  });

  it("빈 문자열/공백만 있으면 null을 반환한다 (빈 문자열 저장 금지)", () => {
    expect(normalizeReasonDetail("")).toBeNull();
    expect(normalizeReasonDetail("   ")).toBeNull();
    expect(normalizeReasonDetail(undefined)).toBeNull();
    expect(normalizeReasonDetail(null)).toBeNull();
  });

  it("200자를 넘으면 200자로 자른다", () => {
    const long = "가".repeat(250);
    const result = normalizeReasonDetail(long);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(200);
  });
});

describe("isReasonDetailRequired", () => {
  it("OTHER 사유일 때만 상세 사유를 요구한다", () => {
    expect(isReasonDetailRequired("OTHER")).toBe(true);
    expect(isReasonDetailRequired("EVENT")).toBe(false);
    expect(isReasonDetailRequired(null)).toBe(false);
  });
});

describe("memberFacingBadge", () => {
  it("MEMBER는 배지가 없다", () => {
    expect(memberFacingBadge("MEMBER")).toBeNull();
  });
  it("ADMIN_ASSIGNMENT와 ADMIN_FREE는 회원에게 동일하게 '관리자 배치 예약'으로만 표시된다 (무료 여부 비공개)", () => {
    expect(memberFacingBadge("ADMIN_ASSIGNMENT")).toBe("관리자 배치 예약");
    expect(memberFacingBadge("ADMIN_FREE")).toBe("관리자 배치 예약");
  });
});

describe("adminBadges", () => {
  it("일반 직접배치는 '관리자 배치' 배지를 포함한다", () => {
    const badges = adminBadges({ type: "ADMIN_ASSIGNMENT", isCapacityOverride: false, status: "confirmed" });
    expect(badges).toContain("관리자 배치");
    expect(badges).not.toContain("무료 추가 배치");
  });
  it("무료 추가 배치는 '무료 추가 배치' 배지를 포함한다", () => {
    const badges = adminBadges({ type: "ADMIN_FREE", isCapacityOverride: false, status: "confirmed" });
    expect(badges).toContain("무료 추가 배치");
  });
  it("정원 초과 배치는 별도 배지가 추가된다", () => {
    const badges = adminBadges({ type: "ADMIN_ASSIGNMENT", isCapacityOverride: true, status: "confirmed" });
    expect(badges).toContain("정원 초과 배치");
  });
  it("취소된 예약은 '취소됨' 배지가 추가된다", () => {
    const badges = adminBadges({ type: "ADMIN_FREE", isCapacityOverride: false, status: "cancelled" });
    expect(badges).toContain("취소됨");
  });
  it("MEMBER 타입은 관리자 배치류 배지를 만들지 않는다", () => {
    const badges = adminBadges({ type: "MEMBER", isCapacityOverride: false, status: "confirmed" });
    expect(badges).not.toContain("관리자 배치");
    expect(badges).not.toContain("무료 추가 배치");
  });
});

describe("상수값이 DB CHECK 제약과 일치해야 하는 값들", () => {
  it("RESERVATION_TYPES는 정확히 3개 값이다", () => {
    expect(RESERVATION_TYPES).toEqual(["MEMBER", "ADMIN_ASSIGNMENT", "ADMIN_FREE"]);
  });
  it("RESERVATION_SOURCES는 정확히 3개 값이다", () => {
    expect(RESERVATION_SOURCES).toEqual(["USER", "ADMIN", "SYSTEM"]);
  });
  it("ADMIN_REASON_CODES는 9개 값이다", () => {
    expect(ADMIN_REASON_CODES.length).toBe(9);
    expect(ADMIN_REASON_CODES).toContain("OTHER");
  });
});
