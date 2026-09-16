/*
  실기기 QA(2026-09-15) 정책 회귀 방지 — Google도 Apple과 동일한 정책을 따른다: "iOS/
  Android 네이티브에서 GoogleSignIn 플러그인을 찾지 못했다고 signInWithOAuth로
  폴백하지 말 것." 기존 signInWithOAuth("google")가 WKWebView 안에서
  "disallowed_useragent"로 막혀 앱이 아예 로그인되지 않고, 그 상태에서 돌아오면 모든
  소셜 버튼이 영구 비활성화되는 사고(release blocker)로 이어졌던 바로 그 경로다 —
  네이티브 플러그인 호출이 실패해도 이 웹 OAuth 경로로는 절대 폴백하지 않는다는 정책을
  appleAuth.noOAuthFallback.test.ts와 동일한 두 가지 방식으로 고정한다.
*/
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isPluginUnavailableError } from "../../lib/googleAuth";

describe("googleAuth.isPluginUnavailableError", () => {
  it("Capacitor의 registerPlugin() 'not implemented' 예외를 인식한다", () => {
    expect(isPluginUnavailableError({ message: '"GoogleSignIn.authorize()" is not implemented on ios' })).toBe(true);
  });
  it("ExceptionCode.Unimplemented(code: 'UNIMPLEMENTED')도 인식한다", () => {
    expect(isPluginUnavailableError({ code: "UNIMPLEMENTED", message: "plugin not implemented" })).toBe(true);
  });
  it("취소/네트워크 등 무관한 에러는 false", () => {
    expect(isPluginUnavailableError({ code: "canceled", message: "canceled" })).toBe(false);
    expect(isPluginUnavailableError({ message: "network request failed" })).toBe(false);
  });
});

describe("app/login/page.tsx — google 네이티브 분기가 공용 signInWithOAuth 호출보다 먼저 return한다(정책 고정)", () => {
  it("provider === \"google\" && isGoogleNativeSignInSupported() 분기 안에 signInWithOAuth 호출이 없고, 분기 끝에 return이 있다", () => {
    const source = readFileSync(join(__dirname, "../../app/login/page.tsx"), "utf-8");
    const googleBranchStart = source.indexOf('if (provider === "google" && isGoogleNativeSignInSupported())');
    expect(googleBranchStart).toBeGreaterThan(-1);
    const nextConstIdx = source.indexOf("const { error } = await supabase.auth.signInWithOAuth", googleBranchStart);
    expect(nextConstIdx).toBeGreaterThan(-1);
    const googleBranchSlice = source.slice(googleBranchStart, nextConstIdx);
    // 주석에서 "signInWithOAuth를 안 쓴다"고 설명하는 건 허용 — 실제 "호출"만 금지한다.
    expect(googleBranchSlice).not.toContain("supabase.auth.signInWithOAuth");
    expect(googleBranchSlice).toContain("signInWithGoogleNative");
    expect(googleBranchSlice).toContain("return;");
  });

  it("네이티브 미지원(일반 웹)일 때는 이 분기를 건너뛰고 아래 공용 signInWithOAuth 경로로 자연스럽게 이어진다", () => {
    const source = readFileSync(join(__dirname, "../../app/login/page.tsx"), "utf-8");
    // 조건에 isGoogleNativeSignInSupported()가 걸려 있어야 웹에서는 이 분기 자체가
    // 실행되지 않고 아래 공용 OAuth 코드로 흘러간다 — 정책 15번(웹은 기존 OAuth 유지).
    expect(source).toContain('if (provider === "google" && isGoogleNativeSignInSupported())');
  });
});
