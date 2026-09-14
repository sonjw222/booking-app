/*
  릴리스 폴리시 배치(2026-09-14) — 하단 Nav "3탭→5탭" 깜빡임 수정. 이 앱은 클라이언트
  라우팅이 없어 탭 전환마다 전체 페이지가 서버에서 다시 렌더링되므로(app/layout.tsx 주석
  참고), 쿠키로 넘어온 원시 문자열을 서버 컴포넌트가 올바르게 해석하는지 검증한다.
*/
import { describe, expect, it } from "vitest";
import { parseHasUsableMembershipCookie } from "../../lib/navState";

describe("parseHasUsableMembershipCookie", () => {
  it("쿠키가 없으면(최초 진입) null — 판정 전으로 취급된다", () => {
    expect(parseHasUsableMembershipCookie(undefined)).toBeNull();
  });
  it("\"1\"이면 true", () => {
    expect(parseHasUsableMembershipCookie("1")).toBe(true);
  });
  it("\"0\"이면 false", () => {
    expect(parseHasUsableMembershipCookie("0")).toBe(false);
  });
  it("알 수 없는 값은 null로 안전하게 취급된다", () => {
    expect(parseHasUsableMembershipCookie("garbage")).toBeNull();
  });
});
