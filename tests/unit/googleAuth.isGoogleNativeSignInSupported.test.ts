/*
  Google 네이티브 로그인 전환(release blocker, 2026-09-15) — Apple과 달리 Google
  네이티브 SDK는 iOS/Android 둘 다 있어(GoogleSignIn-iOS, androidx.credentials)
  isGoogleNativeSignInSupported()는 네이티브 플랫폼이면 플랫폼 종류와 무관하게 true를
  내야 한다(app/login/page.tsx가 이 값으로 네이티브 경로 vs 웹 signInWithOAuth 경로를
  가른다). @capacitor/core를 모킹해 iOS 네이티브/Android 네이티브/일반 웹 세 가지
  플랫폼에서 각각 올바른 값을 내는지 고정한다.
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

import { isGoogleNativeSignInSupported } from "../../lib/googleAuth";

describe("isGoogleNativeSignInSupported", () => {
  beforeEach(() => {
    mockState.isNative = false;
    mockState.platform = "web";
  });

  it("iOS 네이티브 앱에서는 true", () => {
    mockState.isNative = true;
    mockState.platform = "ios";
    expect(isGoogleNativeSignInSupported()).toBe(true);
  });

  it("Android 네이티브 앱에서도 true — Apple과 달리 Google 네이티브 SDK는 두 플랫폼 다 있음", () => {
    mockState.isNative = true;
    mockState.platform = "android";
    expect(isGoogleNativeSignInSupported()).toBe(true);
  });

  it("일반 웹 브라우저에서는 false — 기존 signInWithOAuth 경로를 그대로 써야 함", () => {
    mockState.isNative = false;
    mockState.platform = "web";
    expect(isGoogleNativeSignInSupported()).toBe(false);
  });
});
