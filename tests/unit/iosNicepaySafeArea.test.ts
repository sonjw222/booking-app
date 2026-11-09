import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import config from "../../capacitor.config";

/* iOS 실기기 QA(2026-11-09): NICEPAY 결제창 상단 헤더·X 버튼이 상태바 뒤에 가려짐 → NICEPAY 호스트에 있는 동안에만 WKWebView 에 시스템 안전 영역 적용(NicepaySafeAreaObserver).
   실제 WKWebView 동작은 iOS 시뮬레이터 하니스(tests/qa/iosSafeArea)와 실기기 QA 로 확인한다. 여기서는 소스 계약과 순수 판정 로직을 지킨다. */
const root = join(__dirname, "../..");
const nav = readFileSync(join(root, "ios/App/App/NavigationPolicyPlugin.swift"), "utf-8");
const scene = readFileSync(join(root, "ios/App/App/SceneDelegate.swift"), "utf-8");

describe("NICEPAY 결제창 안전 영역 보정 — 소스 계약", () => {
  it("Swift 호스트 목록은 capacitor.config.ts 의 NICEPAY allowNavigation 과 정확히 같다(어긋나면 결제창은 열려도 보정이 안 되거나 반대)", () => {
    const swiftHosts = [...(/nicepayHosts: Set<String> = \[([^\]]+)\]/.exec(nav)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
    const cfgHosts = ((config.server?.allowNavigation ?? []) as string[]).filter((h) => /nicepay/i.test(h)).sort();
    expect(swiftHosts.length).toBe(3); expect(swiftHosts).toEqual(cfgHosts);
    expect(swiftHosts.some((h) => h.includes("*"))).toBe(false);
  });
  it("전역 설정은 그대로 — contentInset=never, StatusBar.overlaysWebView=true, 허용 목록 기존 항목 불변", () => {
    expect(config.ios?.contentInset).toBe("never");
    expect((config.plugins as { StatusBar?: { overlaysWebView?: boolean } }).StatusBar?.overlaysWebView).toBe(true);
    const hosts = (config.server?.allowNavigation ?? []) as string[];
    for (const h of ["kauth.kakao.com", "*.kakao.com", "nid.naver.com", "*.naver.com", "accounts.google.com", "*.google.com", "appleid.apple.com", "*.apple.com", "bxntqggkfwnhcczsbqtj.supabase.co"]) expect(hosts).toContain(h);
  });
  it("관찰자는 contentInsetAdjustmentBehavior 하나만 바꾸고(StatusBar·frame·CSS·DOM 주입 없음), 시작 값으로 복원하며, 호스트 목록 재정의는 DEBUG 에서만 가능", () => {
    const body = nav.slice(nav.indexOf("final class NicepaySafeAreaObserver"));
    expect(body).toContain("scroll.contentInsetAdjustmentBehavior = .always"); expect(body).toContain("scroll.contentInsetAdjustmentBehavior = appDefault");
    expect(body).toContain("webView.scrollView.contentInsetAdjustmentBehavior   // 앱의 기본값");
    for (const forbidden of ["evaluateJavaScript", "StatusBar", "setNeedsStatusBarAppearanceUpdate", "additionalSafeAreaInsets", ".frame =", "WKUserScript", "addUserScript"]) expect(body, forbidden).not.toContain(forbidden);
    const dbg = scene.slice(scene.indexOf("#if DEBUG"), scene.indexOf("#endif"));
    expect(dbg).toContain('getPluginConfig("NicepaySafeArea")');
    expect(scene.replace(dbg, "")).not.toContain("NicepaySafeArea\")");   // DEBUG 블록 밖에서는 설정 재정의를 읽지 않는다
    expect(scene).toContain("NicepaySafeAreaObserver(webView: webView, appHost:");
  });
  it("Android 는 이 변경과 무관하다 — Swift 파일만 바뀌고 android/ 에는 NICEPAY 안전 영역 코드가 없다", () => {
    const g = spawnSync("git", ["grep", "-il", "NicepaySafeArea", "--", "android"], { cwd: root, encoding: "utf-8" });
    expect(g.stdout.trim()).toBe("");   // git grep 은 일치가 없으면 종료 코드 1
  });
});

const swiftc = spawnSync("swiftc", ["--version"], { encoding: "utf-8" });
describe.skipIf(swiftc.status !== 0)("NicepaySafeAreaPolicy 순수 판정(swiftc 컴파일·실행)", () => {
  it("NICEPAY 호스트→적용, 앱 호스트→복원, 그 밖·빈 값→유지(대소문자 무시, 유사 도메인 불일치)", () => {
    const start = nav.indexOf("enum NicepaySafeAreaPolicy"), end = nav.indexOf("final class NicepaySafeAreaObserver");
    const dir = mkdtempSync(join(tmpdir(), "np-safearea-"));
    writeFileSync(join(dir, "main.swift"), `import Foundation
${nav.slice(start, end)}
var failures = 0
func check(_ name: String, _ got: NicepaySafeAreaPolicy.Action, _ want: NicepaySafeAreaPolicy.Action) { if got != want { failures += 1; print("FAIL \\(name): \\(got) != \\(want)") } }
let app = "mwhabit.com"
for h in ["pg-web.nicepay.co.kr", "dc1-web.nicepay.co.kr", "web.nicepay.co.kr", "PG-WEB.NICEPAY.CO.KR"] { check(h, NicepaySafeAreaPolicy.action(forHost: h, appHost: app), .applySystemInset) }
check("app", NicepaySafeAreaPolicy.action(forHost: "mwhabit.com", appHost: app), .restoreAppDefault)
check("APP", NicepaySafeAreaPolicy.action(forHost: "MWHABIT.COM", appHost: app), .restoreAppDefault)
for h in ["webapi.nicepay.co.kr", "dc2-web.nicepay.co.kr", "nicepay.co.kr.evil.example", "evilnicepay.co.kr", "kauth.kakao.com", "accounts.google.com", "example.com", ""] { check(h, NicepaySafeAreaPolicy.action(forHost: h, appHost: app), .keep) }
check("nil", NicepaySafeAreaPolicy.action(forHost: nil, appHost: app), .keep)
check("noApp", NicepaySafeAreaPolicy.action(forHost: "mwhabit.com", appHost: nil), .keep)
check("override", NicepaySafeAreaPolicy.action(forHost: "127.0.0.1", appHost: app, hosts: ["127.0.0.1"]), .applySystemInset)
print(failures == 0 ? "OK" : "FAILED"); exit(failures == 0 ? 0 : 1)
`);
    const c = spawnSync("swiftc", ["-o", join(dir, "t"), join(dir, "main.swift")], { encoding: "utf-8" });
    expect(c.status, c.stderr).toBe(0);
    const r = spawnSync(join(dir, "t"), [], { encoding: "utf-8" });
    expect(r.stdout.trim(), r.stdout + r.stderr).toBe("OK");
  }, 120_000);
});
