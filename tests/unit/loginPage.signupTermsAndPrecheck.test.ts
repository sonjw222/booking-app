/*
  실기기 QA(2026-09-29) — 회원가입 약관 UI(전체 동의) + 이메일 사전 중복 확인 흐름.
  이 파일은 렌더링 도구 없이(@testing-library/react 등 미사용, 이 프로젝트 기존 관례
  — tests/unit/loginPage.socialLoadingReset.test.ts 참고) 소스 구조를 확인한다.
*/
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(join(__dirname, "../../app/login/page.tsx"), "utf-8");

describe("회원가입 약관 — 전체 동의", () => {
  it("전체 동의 체크박스가 기존 3개 약관 뒤(아래)에 있다", () => {
    const marketingIdx = source.indexOf("이벤트·혜택 알림 수신 동의");
    const allAgreeIdx = source.indexOf("signup-agree-all");
    expect(marketingIdx).toBeGreaterThan(-1);
    expect(allAgreeIdx).toBeGreaterThan(marketingIdx);
  });

  it("전체 동의는 별도 state가 아니라 3개 개별 값의 파생값이다(체크됨 = 3개 모두 체크)", () => {
    const block = source.slice(source.indexOf("signup-agree-all"), source.indexOf("signup-agree-all") + 400);
    expect(block).toContain("checked={agreeTerms && agreePrivacy && agreeMarketing}");
  });

  it("전체 동의를 누르면 3개 모두 같은 값으로 설정된다(체크→전체 체크, 해제→전체 해제)", () => {
    const block = source.slice(source.indexOf("signup-agree-all"), source.indexOf("signup-agree-all") + 500);
    expect(block).toContain("setAgreeTerms(e.target.checked)");
    expect(block).toContain("setAgreePrivacy(e.target.checked)");
    expect(block).toContain("setAgreeMarketing(e.target.checked)");
  });

  it("최종 가입 필수 조건은 여전히 이용약관·개인정보처리방침 2개뿐(마케팅 동의는 선택)", () => {
    expect(source).toContain('if (mode === "signup" && (!agreeTerms || !agreePrivacy))');
    expect(source).not.toMatch(/!agreeTerms \|\| !agreePrivacy \|\| !agreeMarketing/);
  });

  it("기존 약관 상세 링크(이용약관/개인정보처리방침)는 그대로 유지된다", () => {
    expect(source).toContain('href="/legal/terms"');
    expect(source).toContain('href="/legal/privacy"');
  });
});

describe("이메일 사전 중복 확인 — OTP 발송 전 차단", () => {
  const submitFn = source.slice(source.indexOf("async function submit()"), source.indexOf("return (\n    <div className=\"app-shell auth-page-v2\">"));

  it("계정 단계(account)에서 다음을 누르면 OTP 단계로 넘어가기 전에 이메일을 먼저 확인한다", () => {
    expect(submitFn).toContain("checkEmailAvailable(email.trim())");
    const checkIdx = submitFn.indexOf("checkEmailAvailable");
    const setStepIdx = submitFn.indexOf('setSignupStep("profile")');
    expect(checkIdx).toBeGreaterThan(-1);
    expect(setStepIdx).toBeGreaterThan(checkIdx); // 확인이 먼저, 단계 전환은 그 다음
  });

  it("이미 가입된 이메일이면 signupStep을 바꾸지 않고 즉시 return한다(OTP 발송 없음)", () => {
    const guardIdx = submitFn.indexOf("if (!check.available)");
    expect(guardIdx).toBeGreaterThan(-1);
    const guardBlock = submitFn.slice(guardIdx, guardIdx + 200);
    expect(guardBlock).toContain("return");
    expect(guardBlock).not.toContain('setSignupStep("profile")');
  });

  it("sendPhoneOtp는 이메일 확인 이후 단계(signupStep === profile)에서만 호출된다 — account 단계에서 OTP를 먼저 보내지 않는다", () => {
    expect(submitFn).not.toContain("sendPhoneOtp");
  });
});
