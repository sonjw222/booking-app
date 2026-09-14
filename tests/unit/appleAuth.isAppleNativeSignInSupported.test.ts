/*
  Android UX 정리(2026-09-14) — Apple 로그인 버튼은 iOS 네이티브 앱에서만 보여야 한다
  (ASAuthorizationAppleIDProvider가 iOS/macOS 전용 API라 Android/웹에는 애초에 대응하는
  게 없음 — app/login/page.tsx가 이 함수로 버튼 노출 여부를 결정한다). @capacitor/core를
  모킹해 iOS 네이티브/Android 네이티브/일반 웹 세 가지 플랫폼에서 각각 올바른 값을
  내는지 고정한다.
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

import { isAppleNativeSignInSupported } from "../../lib/appleAuth";

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
});
