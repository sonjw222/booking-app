/*
  릴리스 폴리시 배치(2026-09-14) — 관리자 하단 Nav "3탭→4탭" 깜빡임 수정. 이 앱은 클라이언트
  라우팅이 없어 관리자 탭 전환도 매번 전체 페이지가 서버에서부터 다시 렌더링되므로
  (app/layout.tsx 주석 참고), 쿠키로 넘어온 원시 문자열을 서버 컴포넌트가 올바르게
  해석하는지 검증한다 — 판정 전(null)에는 권한 없는 스태프에게 "회원" 탭이 보이면
  안 되므로 항상 숨김으로 취급돼야 한다(ManagerNav.tsx 참고).
*/
import { describe, expect, it } from "vitest";
import { parseCanSeeMembersCookie } from "../../lib/roles";

describe("parseCanSeeMembersCookie", () => {
  it("쿠키가 없으면(최초 진입) null — 판정 전으로 취급된다", () => {
    expect(parseCanSeeMembersCookie(undefined)).toBeNull();
  });
  it("\"1\"이면 true", () => {
    expect(parseCanSeeMembersCookie("1")).toBe(true);
  });
  it("\"0\"이면 false", () => {
    expect(parseCanSeeMembersCookie("0")).toBe(false);
  });
  it("알 수 없는 값은 null로 안전하게 취급된다(권한 없는 것처럼 숨김)", () => {
    expect(parseCanSeeMembersCookie("garbage")).toBeNull();
  });
});
