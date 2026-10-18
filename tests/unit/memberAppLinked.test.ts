import { describe, it, expect } from "vitest";
import { deriveAppLinked } from "../../lib/members";

describe("deriveAppLinked (UX-14)", () => {
  it("저장 플래그가 false여도 프로필이 앱 계정을 가리키면 연결됨 — 전화번호가 없어도 마찬가지", () => {
    expect(deriveAppLinked({ storedFlag: false, profileAccountId: "acc-1" })).toBe(true);
  });
  it("가족(추가) 프로필도 같은 계정 소유이므로 연결됨", () => {
    expect(deriveAppLinked({ storedFlag: false, profileAccountId: "acc-1" })).toBe(true);
    expect(deriveAppLinked({ storedFlag: null, profileAccountId: "acc-1" })).toBe(true);
  });
  it("계정이 없고 플래그도 없으면 실제 미연결", () => {
    expect(deriveAppLinked({ storedFlag: false, profileAccountId: null })).toBe(false);
    expect(deriveAppLinked({ storedFlag: undefined, profileAccountId: undefined })).toBe(false);
  });
  it("저장 플래그가 true면 연결됨(기존 동작 유지)", () => {
    expect(deriveAppLinked({ storedFlag: true, profileAccountId: null })).toBe(true);
  });
});
