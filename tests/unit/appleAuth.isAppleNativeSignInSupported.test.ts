/*
  Apple 인증 정책 — iOS 네이티브 앱은 ASAuthorizationAppleIDProvider, 일반 웹은
  Supabase OAuth를 사용한다. 인증 수단이 없는 Android 네이티브 앱에서만 버튼을 숨긴다.
  @capacitor/core를 모킹해 세 플랫폼의 네이티브 지원/버튼 노출을 각각 고정한다.
*/
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockState = { isNative: false, platform: "web" };

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => mockState.isNative,
    getPlatform: () => mockState.platform,
  },
  registerPlugin: () => ({}),
}));

import { isAppleNativeSignInSupported, shouldShowAppleSignInButton } from "../../lib/appleAuth";

describe("isAppleNativeSignInSupported", () => {
  beforeEach(() => {
    mockState.isNative = false;
    mockState.platform = "web";
  });

  it("iOS 네이티브 앱에서는 true — Apple 버튼이 보여야 함", () => {
    mockState.isNative = true;
    mockState.platform = "ios";
    expect(isAppleNativeSignInSupported()).toBe(true);
  });

  it("Android 네이티브 앱에서는 false — Apple 버튼이 숨겨져야 함", () => {
    mockState.isNative = true;
    mockState.platform = "android";
    expect(isAppleNativeSignInSupported()).toBe(false);
  });

  it("일반 웹 브라우저에서는 false — 네이티브 API가 없어 어차피 동작 못 함", () => {
    mockState.isNative = false;
    mockState.platform = "web";
    expect(isAppleNativeSignInSupported()).toBe(false);
  });

  it("일반 웹에서는 OAuth 버튼을 보여준다", () => {
    expect(shouldShowAppleSignInButton()).toBe(true);
  });

  it("Android 네이티브 앱에서만 버튼을 숨긴다", () => {
    mockState.isNative = true;
    mockState.platform = "android";
    expect(shouldShowAppleSignInButton()).toBe(false);
  });
});
