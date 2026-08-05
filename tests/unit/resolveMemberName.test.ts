/*
  관리자 1:1 문의 목록의 "회원이름 - 센터이름" 표시(섹션 6 재검증)를 위한
  resolveMemberName() 순수 함수 단위 테스트. fetchCenterThreads()가 이 함수 전에는
  memberName을 전혀 채우지 않아 "센터이름 회원"으로만 보이던 문제의 실제 수정 대상이다.
*/
import { describe, expect, it } from "vitest";
import { resolveMemberName } from "../../lib/inquiries";

describe("resolveMemberName", () => {
  it("대표 프로필의 nickname을 최우선으로 쓴다", () => {
    expect(
      resolveMemberName({
        name: "계정이름",
        profiles: [{ nickname: "닉네임", name: "프로필이름", is_primary: true }],
      })
    ).toBe("닉네임");
  });

  it("nickname이 없으면 대표 프로필의 name을 쓴다", () => {
    expect(
      resolveMemberName({
        name: "계정이름",
        profiles: [{ nickname: null, name: "프로필이름", is_primary: true }],
      })
    ).toBe("프로필이름");
  });

  it("프로필 정보가 전혀 없으면 계정 이름(accounts.name)으로 폴백한다", () => {
    expect(resolveMemberName({ name: "계정이름", profiles: [] })).toBe("계정이름");
  });

  it("여러 프로필 중 is_primary인 것을 우선 선택한다", () => {
    expect(
      resolveMemberName({
        name: "계정이름",
        profiles: [
          { nickname: null, name: "가족프로필", is_primary: false },
          { nickname: "본인닉네임", name: "본인이름", is_primary: true },
        ],
      })
    ).toBe("본인닉네임");
  });

  it("RLS로 accounts 자체가 막혀 null이면 '회원'으로 안전하게 폴백한다", () => {
    expect(resolveMemberName(null)).toBe("회원");
    expect(resolveMemberName(undefined)).toBe("회원");
  });

  it("이름 관련 필드가 전부 비어있으면 '회원'으로 폴백한다", () => {
    expect(resolveMemberName({ name: "", profiles: [{ nickname: "", name: "", is_primary: true }] })).toBe("회원");
  });
});
