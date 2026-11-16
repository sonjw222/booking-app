// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const nav = readFileSync("ios/App/App/NavigationPolicyPlugin.swift", "utf8"), scene = readFileSync("ios/App/App/SceneDelegate.swift", "utf8");

describe("네이티브 소스 계약 — 최소 범위(앱 전역 바운스는 그대로)", () => {
  it("기존 NavigationPolicy 플러그인에 setVerticalBounceEnabled 만 추가(새 플러그인 없음)", () => {
    expect(nav).toContain('CAPPluginMethod(name: "setVerticalBounceEnabled", returnType: CAPPluginReturnPromise)');
    expect(nav).toContain("@objc func setVerticalBounceEnabled(_ call: CAPPluginCall)");
    expect(scene).not.toMatch(/registerPluginInstance\(VerticalBounce/);
  });
  it("SceneDelegate 의 앱 전역 bounces/alwaysBounceVertical = true 는 유지되고 false 로 고정하지 않는다", () => {
    expect(scene).toContain("webView.scrollView.bounces = true"); expect(scene).toContain("webView.scrollView.alwaysBounceVertical = true");
    expect(scene).not.toMatch(/bounces\s*=\s*false|alwaysBounceVertical\s*=\s*false/);
  });
  it("끄기 전 값을 저장·복원하고, 새 문서 로드·백그라운드 전환에서도 복원한다", () => {
    expect(nav).toMatch(/observe\(\\\.isLoading/); expect(nav).toContain("willResignActiveNotification"); expect(nav).toContain("restore()");
    expect(scene).toContain("VerticalBounceController.shared.install(on: webView)");
  });
  it("비공개 API 를 쓰지 않는다", () => { const code = nav.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, ""); expect(code).not.toMatch(/_scrollView|performSelector|valueForKey|setValue\(forKey/); });
});

const swiftc = spawnSync("swiftc", ["--version"], { encoding: "utf-8" });
describe.skipIf(swiftc.status !== 0)("VerticalBounceState 순수 로직(swiftc 컴파일·실행)", () => {
  it("처음 끌 때만 원래 값 저장, 복원은 1회, 끈 적 없으면 아무것도 안 함", () => {
    const a = nav.indexOf("struct VerticalBounceState"), b = nav.indexOf("final class VerticalBounceController");
    const dir = mkdtempSync(join(tmpdir(), "vb-"));
    writeFileSync(join(dir, "main.swift"), `import Foundation
${nav.slice(a, b)}
var st = VerticalBounceState(); var f = 0
func ck(_ n: String, _ c: Bool) { if !c { f += 1; print("FAIL", n) } }
ck("restore without disable", st.restore() == nil)
let a1 = st.disable(currentBounces: true, currentAlwaysBounceVertical: true); ck("apply false", a1.bounces == false && a1.alwaysBounceVertical == false)
_ = st.disable(currentBounces: false, currentAlwaysBounceVertical: false)
let r = st.restore(); ck("original kept", r?.bounces == true && r?.alwaysBounceVertical == true)
ck("restore once", st.restore() == nil)
print(f == 0 ? "OK" : "FAILED"); exit(f == 0 ? 0 : 1)
`);
    const c = spawnSync("swiftc", ["-o", join(dir, "t"), join(dir, "main.swift")], { encoding: "utf-8" }); expect(c.status, c.stderr).toBe(0);
    const r = spawnSync(join(dir, "t"), [], { encoding: "utf-8" }); expect(r.stdout.trim(), r.stdout + r.stderr).toBe("OK");
  }, 120_000);
});

describe("lib/nativeBounce — 웹 호출 계약", () => {
  const calls: boolean[] = [];
  beforeEach(() => { vi.resetModules(); calls.length = 0; });
  afterEach(() => { vi.doUnmock("@capacitor/core"); delete (window as unknown as { Capacitor?: unknown }).Capacitor; });
  async function load(platform: "ios" | "android" | "web", withMethod = true) {
    vi.doMock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => platform !== "web", getPlatform: () => platform } }));
    (window as unknown as { Capacitor?: unknown }).Capacitor = { Plugins: { NavigationPolicy: withMethod ? { setVerticalBounceEnabled: (o: { enabled: boolean }) => { calls.push(o.enabled); return Promise.resolve(); } } : {} } };
    return import("../../lib/nativeBounce");
  }
  it("iOS: 첫 acquire 에서 끄고 마지막 release 에서만 복원 — 겹친 시트·중복 release 안전", async () => {
    const m = await load("ios"); const r1 = m.acquireNoVerticalBounce(), r2 = m.acquireNoVerticalBounce();
    expect(calls).toEqual([false]); r1(); r1(); expect(calls).toEqual([false]); r2(); expect(calls).toEqual([false, true]); expect(m.__bounceHoldsForTests()).toBe(0);
  });
  it("pagehide·hidden 이면 복원, 다시 보이고 시트가 열려 있으면 재적용", async () => {
    const m = await load("ios"); const r = m.acquireNoVerticalBounce(); calls.length = 0;
    window.dispatchEvent(new Event("pagehide")); expect(calls).toEqual([true]);
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true }); document.dispatchEvent(new Event("visibilitychange")); expect(calls).toEqual([true, false]);
    r(); expect(calls.at(-1)).toBe(true);
  });
  it("Android·웹·메서드 없는 구버전 앱에서는 no-op(오류 없음)", async () => {
    for (const [pl, wm] of [["android", true], ["web", true], ["ios", false]] as const) { vi.resetModules(); calls.length = 0; const m = await load(pl, wm); expect(() => m.acquireNoVerticalBounce()()).not.toThrow(); expect(calls).toEqual([]); }
  });
  it("수강권 안내창(contentDrag)만 쓴다", () => {
    const so = readFileSync("app/components/SheetOverlay.tsx", "utf8"); expect(so).toMatch(/if \(!contentDrag\) return;\s*const release = acquireNoVerticalBounce\(\)/);
  });
});
