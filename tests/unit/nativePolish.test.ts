/*
  성능 배치(2026-10-02) 3: 절제된 native polish(Haptics / Network / Share) — 새 plugin은 Capacitor 8 공식 plugin, 구버전 앱/웹 fallback 유지.
*/
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
const read = (p: string) => readFileSync(join(__dirname, "../..", p), "utf-8");

describe("의존성", () => {
  it("새 plugin 3개는 Capacitor 8과 같은 major, Keyboard plugin은 추가하지 않았다(실측 이득 없음)", () => {
    const pkg = JSON.parse(read("package.json"));
    for (const n of ["haptics", "network", "share"]) expect(pkg.dependencies[`@capacitor/${n}`]).toMatch(/^\^8\./);
    expect(pkg.dependencies["@capacitor/keyboard"]).toBeUndefined();
    expect(read("ios/App/CapApp-SPM/Package.swift")).toMatch(/capacitor-haptics|CapacitorHaptics/i);
  });
});

describe("Haptics는 주요 결과 action에만", () => {
  it("예약 완료(확정) / 예약 취소 완료 / 결제 완료 3곳에서만 호출, 플러그인 없으면 조용히 무시", () => {
    expect(read("app/reservation/page.tsx")).toContain('if (status === "confirmed") void hapticSuccess();');
    expect(read("app/my-reservations/page.tsx")).toContain("void hapticWarning();");
    expect(read("app/checkout/page.tsx")).toContain("if (done && !pendingManualPayment) void hapticSuccess();");
    const h = read("lib/nativeHaptics.ts");
    expect(h).toContain('Capacitor.isPluginAvailable("Haptics")');
    expect(h).toMatch(/catch \{/);
    // 탭/버튼 전반에 쓰지 않는다
    const users = ["app/components/BottomNav.tsx", "app/components/ManagerNav.tsx", "app/components/SwipeRow.tsx"];
    for (const f of users) expect(read(f)).not.toContain("nativeHaptics");
  });
});

describe("오프라인 안내", () => {
  const o = read("app/components/OfflineNotice.tsx");
  it("네이티브 + Network 플러그인이 있을 때만 동작, 상태 리스너 정리, root layout에 한 번만 마운트", () => {
    expect(o).toContain("Capacitor.isNativePlatform()");
    expect(o).toContain('Capacitor.isPluginAvailable("Network")');
    expect(o).toContain("handle.remove()");
    expect(o).toContain("if (!offline) return null;");
    expect((read("app/layout.tsx").match(/<OfflineNotice \/>/g) ?? []).length).toBe(1);
  });
});

describe("공유", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); vi.doUnmock("@capacitor/core"); });
  it("웹: Web Share → 취소(AbortError)는 cancelled → 불가하면 클립보드 복사 → 모두 없으면 unsupported", async () => {
    vi.doMock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => false, isPluginAvailable: () => false } }));
    const { shareLink } = await import("../../lib/nativeShare");
    const input = { title: "t", url: "https://mwhabit.com/center/x" };
    const share = vi.fn(async () => {});
    vi.stubGlobal("navigator", { share });
    expect(await shareLink(input)).toBe("shared");
    vi.stubGlobal("navigator", { share: vi.fn(async () => { throw Object.assign(new Error("x"), { name: "AbortError" }); }) });
    expect(await shareLink(input)).toBe("cancelled");
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    expect(await shareLink(input)).toBe("copied");
    expect(writeText).toHaveBeenCalledWith(input.url);
    vi.stubGlobal("navigator", {});
    expect(await shareLink(input)).toBe("unsupported");
  });
  it("센터 상세에 공유 버튼, 링크는 https://mwhabit.com/center/<id>", () => {
    const c = read("app/center/[id]/page.tsx");
    expect(c).toContain('aria-label="센터 공유"');
    expect(c).toContain("https://mwhabit.com/center/${centerId}");
  });
});

describe("네이티브/결제 구조 보존", () => {
  it("server.url 모드 유지, Universal Link entitlement·SceneDelegate 보존", () => {
    expect(read("capacitor.config.ts")).toContain('url: "https://mwhabit.com"');
    expect(read("ios/App/App/App.entitlements")).toContain("applinks:mwhabit.com");
    expect(read("ios/App/App/SceneDelegate.swift")).toContain("SceneDelegateProxy.shared.scene(scene, continue: userActivity)");
  });
});
