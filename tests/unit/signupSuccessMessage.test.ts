/*
  회원가입 완료 안내 문구 회귀 테스트(섹션 1). 이메일 인증을 실제로 쓰지 않는데도
  "확인 메일이 발송됐어요"라고 거짓 안내하던 문제의 재발을 막는다.
*/
// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { SIGNUP_SUCCESS_MESSAGE } from "../../app/login/page";

describe("SIGNUP_SUCCESS_MESSAGE", () => {
  it("이메일/메일/인증을 언급하지 않는다(실제로 발송되지 않으므로 거짓 안내 금지)", () => {
    expect(SIGNUP_SUCCESS_MESSAGE).not.toContain("메일");
    expect(SIGNUP_SUCCESS_MESSAGE).not.toContain("인증");
  });
  it("가입 완료와 로그인 안내를 포함한다", () => {
    expect(SIGNUP_SUCCESS_MESSAGE).toContain("완료");
    expect(SIGNUP_SUCCESS_MESSAGE).toContain("로그인");
  });
});
