/*
  실기기 QA(2026-09-14) 정책 회귀 방지: "iOS native에서 AppleSignIn 플러그인을 찾지
  못했다고 signInWithOAuth로 폴백하지 말 것 — 앱 내부 오류로 끝내고 browser OAuth
  페이지를 절대 열지 않는다." 실기기에서 Apple 버튼이 Supabase의 raw OAuth 에러 JSON
  화면으로 떨어진 사고(HTTP 400 "Unsupported provider: missing OAuth secret")가 실제로
  있었다 — 이 테스트는 그 정책이 코드에 남아있는지 두 가지 방식으로 고정한다.
*/
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isPluginUnavailableError } from "../../lib/appleAuth";

describe("isPluginUnavailableError", () => {
  it("Capacitor의 registerPlugin() 'not implemented' 예외를 인식한다", () => {
    expect(isPluginUnavailableError({ message: '"AppleSignIn.authorize()" is not implemented on ios' })).toBe(true);
  });
  it("ExceptionCode.Unimplemented(code: 'UNIMPLEMENTED')도 인식한다", () => {
    expect(isPluginUnavailableError({ code: "UNIMPLEMENTED", message: "plugin not implemented" })).toBe(true);
  });
  it("취소/네트워크 등 무관한 에러는 false", () => {
    expect(isPluginUnavailableError({ code: "canceled", message: "canceled" })).toBe(false);
    expect(isPluginUnavailableError({ message: "network request failed" })).toBe(false);
  });
});

describe("app/login/page.tsx — apple 분기가 공용 signInWithOAuth 호출보다 먼저 return한다(정책 고정)", () => {
  it("provider === \"apple\" 분기 안에 signInWithOAuth 호출이 없고, 분기 끝에 return이 있다", () => {
    const source = readFileSync(join(__dirname, "../../app/login/page.tsx"), "utf-8");
    const appleBranchStart = source.indexOf('if (provider === "apple")');
    expect(appleBranchStart).toBeGreaterThan(-1);
    // apple 분기의 닫는 중괄호까지만 잘라서(다음 최상위 statement 직전) 그 구간에
    // signInWithOAuth 호출이 없는지 확인한다 — 공용 signInWithOAuth 호출부는 그 분기
    // "바깥"(뒤)에 있어야 한다.
    const nextConstIdx = source.indexOf("const { error } = await supabase.auth.signInWithOAuth", appleBranchStart);
    expect(nextConstIdx).toBeGreaterThan(-1);
    const appleBranchSlice = source.slice(appleBranchStart, nextConstIdx);
    // 주석에서 "signInWithOAuth를 안 쓴다"고 설명하는 건 허용 — 실제 "호출"만 금지한다.
    expect(appleBranchSlice).not.toContain("supabase.auth.signInWithOAuth");
    expect(appleBranchSlice).toContain("signInWithAppleNative");
    expect(appleBranchSlice).toContain("return;");
  });
});
