/*
  릴리스 폴리시 배치 7차(2026-09-17) — Android/iOS 상태바 아이콘 색 동기화 회귀 방지.
  이 앱은 시스템 다크/라이트 설정과 별개로 앱 안에서 테마를 직접 고를 수 있는데, 상태바
  아이콘 색은 그동안 한 번도 명시적으로 설정한 적이 없어 기기 시스템 설정만 따라갔다
  (Style.Default) — 시스템은 라이트인데 앱 안에서 차콜(다크)을 고르면 어두운 배경에
  어두운 아이콘이 남는 대비 문제가 생길 수 있었다. 이미 설치된 공식
  @capacitor/status-bar 하나로 iOS/Android 둘 다 고정한다(Style.Dark="어두운 배경용
  밝은 아이콘", Style.Light="밝은 배경용 어두운 아이콘").
*/
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi, beforeEach } from "vitest";

describe("syncNativeStatusBarStyle", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("네이티브 플랫폼이 아니면 @capacitor/status-bar를 아예 import하지 않는다", async () => {
    vi.doMock("@capacitor/core", () => ({
      Capacitor: { isNativePlatform: () => false, getPlatform: () => "web" },
      registerPlugin: () => ({}),
    }));
    const setStyleSpy = vi.fn();
    vi.doMock("@capacitor/status-bar", () => ({
      StatusBar: { setStyle: setStyleSpy },
      Style: { Dark: "DARK", Light: "LIGHT" },
    }));
    const { syncNativeStatusBarStyle } = await import("../../lib/nativeTheme");
    await syncNativeStatusBarStyle(true);
    expect(setStyleSpy).not.toHaveBeenCalled();
  });

  it("다크 테마면 Style.Dark(어두운 배경용 밝은 아이콘)를 적용한다", async () => {
    vi.doMock("@capacitor/core", () => ({
      Capacitor: { isNativePlatform: () => true, getPlatform: () => "ios" },
      registerPlugin: () => ({}),
    }));
    const setStyleSpy = vi.fn().mockResolvedValue(undefined);
    vi.doMock("@capacitor/status-bar", () => ({
      StatusBar: { setStyle: setStyleSpy },
      Style: { Dark: "DARK", Light: "LIGHT" },
    }));
    const { syncNativeStatusBarStyle } = await import("../../lib/nativeTheme");
    await syncNativeStatusBarStyle(true);
    expect(setStyleSpy).toHaveBeenCalledWith({ style: "DARK" });
  });

  it("라이트 테마면 Style.Light(밝은 배경용 어두운 아이콘)를 적용한다", async () => {
    vi.doMock("@capacitor/core", () => ({
      Capacitor: { isNativePlatform: () => true, getPlatform: () => "android" },
      registerPlugin: () => ({}),
    }));
    const setStyleSpy = vi.fn().mockResolvedValue(undefined);
    vi.doMock("@capacitor/status-bar", () => ({
      StatusBar: { setStyle: setStyleSpy },
      Style: { Dark: "DARK", Light: "LIGHT" },
    }));
    const { syncNativeStatusBarStyle } = await import("../../lib/nativeTheme");
    await syncNativeStatusBarStyle(false);
    expect(setStyleSpy).toHaveBeenCalledWith({ style: "LIGHT" });
  });
});

describe("app/layout.tsx 콜드 스타트 인라인 스크립트 — StatusBar.setStyle 호출 고정", () => {
  const source = readFileSync(join(__dirname, "../../app/layout.tsx"), "utf-8");

  it("인라인 스크립트가 window.Capacitor.Plugins.StatusBar.setStyle을 호출한다", () => {
    expect(source).toContain("window.Capacitor.Plugins.StatusBar.setStyle({style:dark?\"DARK\":\"LIGHT\"})");
  });

  it("StatusBar 호출도 WebViewTheme와 동일하게 try/catch로 감싸져 실패해도 화면에 영향 없다", () => {
    const idx = source.indexOf("Plugins.StatusBar.setStyle");
    expect(idx).toBeGreaterThan(-1);
    const before = source.slice(Math.max(0, idx - 120), idx);
    expect(before).toContain("try{window.Capacitor");
  });
});

describe("app/settings/theme/page.tsx — 런타임 테마 전환 시에도 상태바 스타일을 동기화한다", () => {
  const source = readFileSync(join(__dirname, "../../app/settings/theme/page.tsx"), "utf-8");

  it("applyTheme()가 syncNativeStatusBarStyle을 호출한다", () => {
    expect(source).toContain("syncNativeStatusBarStyle(effective === \"charcoal\")");
  });
});
