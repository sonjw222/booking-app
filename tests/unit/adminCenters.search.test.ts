/*
  릴리스 폴리시 배치 8차(2026-09-18), 6번 — 센터 승인 관리 검색 회귀 가드.
  센터명/대표자/주소/전화/사업자번호 매칭, 대소문자 무시, trim, 전화번호 "-" 유무 무관을
  검증한다.
*/
import { describe, expect, it } from "vitest";
import { centerMatchesKeyword, digitsOnly, normalizeSearchText } from "../../app/admin/centers/page";
import type { PendingCenter } from "../../lib/admin";

function makeCenter(overrides: Partial<PendingCenter> = {}): PendingCenter {
  return {
    id: "c1", name: "강남 필라테스", address: "서울 강남구 테헤란로 1",
    phone: "02-1234-5678", businessNumber: "123-45-67890",
    businessLicenseUrl: null, status: "pending", rejectReason: null,
    createdAt: "2026.09.18 10:00", ownerName: "김대표", ownerPhone: "010-1111-2222",
    ...overrides,
  };
}

describe("normalizeSearchText / digitsOnly", () => {
  it("trim + 소문자화", () => {
    expect(normalizeSearchText("  ABC  ")).toBe("abc");
  });
  it("숫자만 추출", () => {
    expect(digitsOnly("02-1234-5678")).toBe("0212345678");
  });
});

describe("centerMatchesKeyword", () => {
  const c = makeCenter();

  it("빈 검색어는 항상 매칭(필터 없음)", () => {
    expect(centerMatchesKeyword(c, "")).toBe(true);
    expect(centerMatchesKeyword(c, "   ")).toBe(true);
  });

  it("센터명 부분일치", () => {
    expect(centerMatchesKeyword(c, "강남")).toBe(true);
    expect(centerMatchesKeyword(c, "필라테스")).toBe(true);
  });

  it("대표자명 매칭", () => {
    expect(centerMatchesKeyword(c, "김대표")).toBe(true);
  });

  it("주소 매칭", () => {
    expect(centerMatchesKeyword(c, "테헤란로")).toBe(true);
  });

  it("전화번호 — '-' 유무와 무관하게 매칭(대표번호)", () => {
    expect(centerMatchesKeyword(c, "0212345678")).toBe(true); // '-' 없이 검색
    expect(centerMatchesKeyword(c, "1234-5678")).toBe(true); // 일부만
  });

  it("전화번호 — 대표자 전화도 매칭", () => {
    expect(centerMatchesKeyword(c, "01011112222")).toBe(true);
  });

  it("사업자번호 매칭('-' 무관)", () => {
    expect(centerMatchesKeyword(c, "1234567890")).toBe(true);
    expect(centerMatchesKeyword(c, "123-45-67890")).toBe(true);
  });

  it("무관한 검색어는 매칭 안 됨", () => {
    expect(centerMatchesKeyword(c, "부산")).toBe(false);
    expect(centerMatchesKeyword(c, "999-999")).toBe(false);
  });

  it("대소문자 무시", () => {
    const eng = makeCenter({ name: "Gangnam Pilates" });
    expect(centerMatchesKeyword(eng, "GANGNAM")).toBe(true);
    expect(centerMatchesKeyword(eng, "gangnam")).toBe(true);
  });

  it("null 필드가 있어도 죽지 않음", () => {
    const noPhone = makeCenter({ phone: null, ownerPhone: null, businessNumber: null, ownerName: null });
    expect(centerMatchesKeyword(noPhone, "강남")).toBe(true);
    expect(centerMatchesKeyword(noPhone, "010")).toBe(false);
  });
});
