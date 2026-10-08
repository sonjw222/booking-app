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

const coreMock = (platform: string, native = true, systemBars?: { setStyle: ReturnType<typeof vi.fn> }, bg?: ReturnType<typeof vi.fn>) => ({
  Capacitor: { isNativePlatform: () => native, getPlatform: () => platform },
  registerPlugin: (name: string) => (name === "AndroidStatusBarBackground" ? { setDark: bg ?? vi.fn().mockResolvedValue(undefined) } : {}),
  SystemBars: systemBars ?? { setStyle: vi.fn() },
  SystemBarsStyle: { Dark: "DARK", Light: "LIGHT", Default: "DEFAULT" },
  SystemBarType: { StatusBar: "StatusBar", NavigationBar: "NavigationBar" },
});

describe("syncNativeStatusBarStyle", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("네이티브 플랫폼이 아니면 StatusBar/SystemBars 어느 쪽도 호출하지 않는다", async () => {
    const sb = { setStyle: vi.fn() };
    vi.doMock("@capacitor/core", () => coreMock("web", false, sb));
    const setStyleSpy = vi.fn();
    vi.doMock("@capacitor/status-bar", () => ({ StatusBar: { setStyle: setStyleSpy }, Style: { Dark: "DARK", Light: "LIGHT" } }));
    const { syncNativeStatusBarStyle } = await import("../../lib/nativeTheme");
    await syncNativeStatusBarStyle(true);
    expect(setStyleSpy).not.toHaveBeenCalled();
    expect(sb.setStyle).not.toHaveBeenCalled();
  });

  it("iOS 다크 테마면 기존 경로 StatusBar.setStyle(Style.Dark)를 쓰고 SystemBars는 건드리지 않는다", async () => {
    const sb = { setStyle: vi.fn() };
    vi.doMock("@capacitor/core", () => coreMock("ios", true, sb));
    const setStyleSpy = vi.fn().mockResolvedValue(undefined);
    vi.doMock("@capacitor/status-bar", () => ({ StatusBar: { setStyle: setStyleSpy }, Style: { Dark: "DARK", Light: "LIGHT" } }));
    const { syncNativeStatusBarStyle } = await import("../../lib/nativeTheme");
    await syncNativeStatusBarStyle(true);
    expect(setStyleSpy).toHaveBeenCalledWith({ style: "DARK" });
    expect(sb.setStyle).not.toHaveBeenCalled();
  });

  it("iOS 라이트 테마면 StatusBar.setStyle(Style.Light)", async () => {
    vi.doMock("@capacitor/core", () => coreMock("ios"));
    const setStyleSpy = vi.fn().mockResolvedValue(undefined);
    vi.doMock("@capacitor/status-bar", () => ({ StatusBar: { setStyle: setStyleSpy }, Style: { Dark: "DARK", Light: "LIGHT" } }));
    const { syncNativeStatusBarStyle } = await import("../../lib/nativeTheme");
    await syncNativeStatusBarStyle(false);
    expect(setStyleSpy).toHaveBeenCalledWith({ style: "LIGHT" });
  });

  it("Android 다크 테마면 SystemBars.setStyle({DARK, StatusBar만})와 뒷배경 동기화를 쓰고 @capacitor/status-bar는 호출하지 않는다", async () => {
    const sb = { setStyle: vi.fn().mockResolvedValue(undefined) }; const bg = vi.fn().mockResolvedValue(undefined);
    vi.doMock("@capacitor/core", () => coreMock("android", true, sb, bg));
    const statusBarSpy = vi.fn();
    vi.doMock("@capacitor/status-bar", () => ({ StatusBar: { setStyle: statusBarSpy }, Style: { Dark: "DARK", Light: "LIGHT" } }));
    const { syncNativeStatusBarStyle } = await import("../../lib/nativeTheme");
    await syncNativeStatusBarStyle(true);
    expect(sb.setStyle).toHaveBeenCalledWith({ style: "DARK", bar: "StatusBar" });   // 내비게이션 바는 건드리지 않는다(이전 동작 유지)
    expect(bg).toHaveBeenCalledWith({ dark: true });
    expect(statusBarSpy).not.toHaveBeenCalled();
  });

  it("Android 라이트 테마면 SystemBars.setStyle({LIGHT, StatusBar})", async () => {
    const sb = { setStyle: vi.fn().mockResolvedValue(undefined) };
    vi.doMock("@capacitor/core", () => coreMock("android", true, sb));
    vi.doMock("@capacitor/status-bar", () => ({ StatusBar: { setStyle: vi.fn() }, Style: { Dark: "DARK", Light: "LIGHT" } }));
    const { syncNativeStatusBarStyle } = await import("../../lib/nativeTheme");
    await syncNativeStatusBarStyle(false);
    expect(sb.setStyle).toHaveBeenCalledWith({ style: "LIGHT", bar: "StatusBar" });
  });

  it("Android에서 SystemBars가 실패해도 예외를 던지지 않는다(화면 영향 없음)", async () => {
    vi.doMock("@capacitor/core", () => coreMock("android", true, { setStyle: vi.fn().mockRejectedValue(new Error("x")) }));
    vi.doMock("@capacitor/status-bar", () => ({ StatusBar: { setStyle: vi.fn() }, Style: {} }));
    const { syncNativeStatusBarStyle } = await import("../../lib/nativeTheme");
    await expect(syncNativeStatusBarStyle(true)).resolves.toBeUndefined();
  });
});

describe("app/layout.tsx 콜드 스타트 인라인 스크립트 — 플랫폼별 상태바 스타일 호출 고정", () => {
  const source = readFileSync(join(__dirname, "../../app/layout.tsx"), "utf-8");

  it("Android는 SystemBars.setStyle({bar:StatusBar}) + AndroidStatusBarBackground, iOS는 기존 StatusBar.setStyle", () => {
    expect(source).toContain('if(cap&&cap.getPlatform&&cap.getPlatform()==="android"){pl&&pl.SystemBars&&pl.SystemBars.setStyle({style:st,bar:"StatusBar"});pl&&pl.AndroidStatusBarBackground&&pl.AndroidStatusBarBackground.setDark({dark:dark});}else{pl&&pl.StatusBar&&pl.StatusBar.setStyle({style:st});}');
    expect(source).toContain('var st=dark?"DARK":"LIGHT";');
  });

  it("상태바 호출은 WebViewTheme와 동일하게 try/catch로 감싸져 실패해도 화면에 영향 없다", () => {
    const idx = source.indexOf("pl.SystemBars.setStyle");
    expect(idx).toBeGreaterThan(-1);
    const before = source.slice(Math.max(0, idx - 220), idx);
    expect(before).toContain("try{var cap=window.Capacitor");
    expect(source).toContain("catch(e3){}");
  });
});

describe("Android 직접 deprecated 호출 없음 + 플러그인/설정 유지(1차 migration 범위)", () => {
  const read = (f: string) => readFileSync(join(__dirname, "../..", f), "utf-8");
  it("앱이 소유한 native/JS 코드는 Window.setStatusBarColor/getStatusBarColor/setNavigationBarColor를 직접 쓰지 않는다", () => {
    const code = (f: string) => read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");   // 주석 제외(설명 문구에 API 이름이 나올 수 있다)
    for (const f of ["android/app/src/main/java/com/mwhabit/app/MainActivity.java", "android/app/src/main/java/com/mwhabit/app/AndroidStatusBarBackgroundPlugin.java", "lib/nativeTheme.ts"]) {
      expect(code(f), f).not.toMatch(/\b(set|get)StatusBarColor\b|setNavigationBarColor|setNavigationBarDividerColor|setDecorFitsSystemWindows/);
    }
  });
  it("1차(JS/API)만: @capacitor/status-bar 의존성과 capacitor.config StatusBar 설정(iOS overlay)은 그대로 둔다", () => {
    expect(JSON.parse(read("package.json")).dependencies["@capacitor/status-bar"]).toBeTruthy();
    expect(read("capacitor.config.ts")).toContain("overlaysWebView: true");
  });
  it("R8 설정(b20be82)이 보존돼 있다", () => {
    const g = read("android/app/build.gradle");
    expect(g).toMatch(/minifyEnabled true/); expect(g).toMatch(/shrinkResources true/); expect(g).toContain("proguard-android-optimize.txt");
  });
});

describe("app/settings/theme/page.tsx — 런타임 테마 전환 시에도 상태바 스타일을 동기화한다", () => {
  const source = readFileSync(join(__dirname, "../../app/settings/theme/page.tsx"), "utf-8");

  it("applyTheme()가 syncNativeStatusBarStyle을 호출한다", () => {
    expect(source).toContain("syncNativeStatusBarStyle(effective === \"charcoal\")");
  });
});
