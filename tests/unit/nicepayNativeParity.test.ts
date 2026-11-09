// @vitest-environment node
/* NICEPAY 앱(WebView) 결제 복귀 — 웹(TS)·iOS(Swift)·Android(Java/Manifest/plist)가 같은 허용 목록·scheme·형식을 쓰는지 소스 수준으로 고정하고,
   기존 로그인(Google URL scheme·SceneDelegate 처리)이 그대로인지·전체 허용(ATS/와일드카드)이 없는지 본다. swiftc 가 있으면 Swift 순수 로직 검사도 실행한다. 실제 NICEPAY·기기 불필요. */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { NICEPAY_ANDROID_PACKAGES, NICEPAY_APP_RETURN_PROPOSED_SCHEME, NICEPAY_IOS_SCHEMES, NICEPAY_NEVER_HANDLE_SCHEMES } from "../../lib/payments/nicepayAppReturn";

const root = path.resolve(__dirname, "../..");
const rd = (p: string) => readFileSync(path.join(root, p), "utf8");
const swift = rd("ios/App/App/NicepayAppReturn.swift"), swiftPlugin = rd("ios/App/App/NicepayAppBridgePlugin.swift");
const java = rd("android/app/src/main/java/com/mwhabit/app/NicepayAppReturn.java"), javaPlugin = rd("android/app/src/main/java/com/mwhabit/app/NicepayAppBridgePlugin.java");
const plist = rd("ios/App/App/Info.plist"), manifest = rd("android/app/src/main/AndroidManifest.xml"), scene = rd("ios/App/App/SceneDelegate.swift"), main = rd("android/app/src/main/java/com/mwhabit/app/MainActivity.java");
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/.*$/gm, "");   // 주석 제외(주석의 설명 문구는 사용자 노출 문구가 아니다)
const quoted = (src: string, anchor: RegExp) => { const m = anchor.exec(src); if (!m) throw new Error("anchor 없음"); return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]); };

describe("허용 목록·scheme 동일성(웹 = iOS = Android)", () => {
  it("Swift cardAppSchemes · Java CARD_APP_SCHEMES · Info.plist LSApplicationQueriesSchemes 가 JSON 목록과 같다", () => {
    expect(quoted(swift, /cardAppSchemes: Set<String> = \[([\s\S]*?)\]/).sort()).toEqual([...NICEPAY_IOS_SCHEMES].sort());
    expect(quoted(java, /CARD_APP_SCHEMES = [\s\S]*?asList\(([\s\S]*?)\)\)\);/).sort()).toEqual([...NICEPAY_IOS_SCHEMES].sort());
    const q = /<key>LSApplicationQueriesSchemes<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(plist)![1];
    expect([...q.matchAll(/<string>([^<]+)<\/string>/g)].map((m) => m[1]).sort()).toEqual([...NICEPAY_IOS_SCHEMES].sort());
    expect(NICEPAY_IOS_SCHEMES.length).toBeLessThanOrEqual(50);   // iOS LSApplicationQueriesSchemes 상한
  });
  it("Java CARD_APP_PACKAGES · Manifest <queries> 가 JSON 패키지 목록과 같다", () => {
    expect(quoted(java, /CARD_APP_PACKAGES = [\s\S]*?asList\(([\s\S]*?)\)\)\);/).sort()).toEqual([...NICEPAY_ANDROID_PACKAGES].sort());
    const q = /<queries>([\s\S]*?)<\/queries>/.exec(manifest)![1];
    expect([...q.matchAll(/<package android:name="([^"]+)"/g)].map((m) => m[1]).sort()).toEqual([...NICEPAY_ANDROID_PACKAGES].sort());
  });
  it("복귀 scheme(제안값)이 TS·Swift·Java·Info.plist·Manifest 모두 같다", () => {
    expect(NICEPAY_APP_RETURN_PROPOSED_SCHEME).toBe("mwhabitnicepay");
    expect(swift).toContain(`static let scheme = "${NICEPAY_APP_RETURN_PROPOSED_SCHEME}"`); expect(java).toContain(`SCHEME = "${NICEPAY_APP_RETURN_PROPOSED_SCHEME}"`);
    expect(plist).toContain(`<string>${NICEPAY_APP_RETURN_PROPOSED_SCHEME}</string>`); expect(manifest).toContain(`android:scheme="${NICEPAY_APP_RETURN_PROPOSED_SCHEME}"`);
    expect(manifest).toContain('android:host="nicepay"');
  });
  it("소셜 로그인·간편결제 scheme/패키지는 어느 목록에도 없다", () => {
    for (const s of NICEPAY_NEVER_HANDLE_SCHEMES) { expect(NICEPAY_IOS_SCHEMES).not.toContain(s); expect(swift).not.toMatch(new RegExp(`"${s}"`)); expect(plist).not.toContain(`<string>${s}</string>`); }
    for (const p of ["com.kakao.talk", "com.nhn.android.search", "viva.republica.toss"]) expect(manifest).not.toContain(p);
  });
  it("복귀 URL 규칙(호스트·경로·쿼리·길이)이 세 구현에서 같다", () => {
    expect(swift).toContain('static let host = "nicepay"'); expect(java).toContain('HOST = "nicepay"');
    for (const src of [swift, java]) { expect(src).toContain('"/wap"'); expect(src).toContain('"/cancel"'); expect(src).toContain("orderId="); expect(src).toContain("500"); expect(src).toContain("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"); }
    expect(swift).toContain('&app=1'); expect(java).toContain('&app=1'); expect(swift).toContain('&cancel=1'); expect(java).toContain('&cancel=1');
  });
});

describe("기존 로그인·보안 설정 보호", () => {
  it("Google 로그인 URL scheme 2개와 SceneDelegate 의 GoogleSignIn 처리가 그대로, NICEPAY 복귀는 그 뒤에서만", () => {
    expect(plist).toContain("com.googleusercontent.apps.6723237524-vq3iilbrjb7d0anqtjk7nfo6gr8p3b7d"); expect(plist).toContain("com.googleusercontent.apps.544111273413-dita3qop20ut2t24dkqgidp6qj8h9qna");
    const g = scene.indexOf("GIDSignIn.sharedInstance.handle(context.url)"), n = scene.indexOf("NicepayAppBridgePlugin.handleReturn(context.url, bridge: bridge)"), p = scene.indexOf("SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)");
    expect(g).toBeGreaterThan(-1); expect(n).toBeGreaterThan(g); expect(p).toBeGreaterThan(n);   // Google → NICEPAY → Capacitor 기존 처리
    expect(scene).toContain("SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)"); expect(scene).toContain("registerPluginInstance(GoogleSignInPlugin())");
  });
  it("ATS 전체 허용·와일드카드 네비게이션·cleartext 허용이 없다", () => {
    expect(plist).not.toMatch(/NSAppTransportSecurity|NSAllowsArbitraryLoads/);
    const cap = rd("capacitor.config.ts"); expect(cap).toContain("cleartext: false"); expect(cap).not.toMatch(/allowNavigation:[^\]]*"\*"[,\]]/); expect(cap).toContain('"*.nicepay.co.kr"');
    expect(manifest).not.toMatch(/usesCleartextTraffic="true"/); expect(manifest).toContain("android:allowBackup=\"false\"");
  });
  it("Android: 기존 Activity 설정 유지 + deep link 는 VIEW/BROWSABLE 한 개, 복귀는 검증 함수만 호출", () => {
    expect(manifest).toContain('android:launchMode="singleTask"'); expect((manifest.match(/mwhabitnicepay/g) ?? []).length).toBe(1);
    expect(main).toContain("handleNicepayReturn(getIntent(), true)"); expect(main).toContain("onNewIntent(Intent intent)"); expect(main).toContain("super.onNewIntent(intent)");
    expect(main).toContain("registerPlugin(GoogleSignInPlugin.class)"); expect(main).toContain("registerPlugin(NicepayAppBridgePlugin.class)");
    expect(javaPlugin).toContain("NicepayAppReturn.parse(raw)");
  });
  it("Android intent:// 는 flags/extras/category/component/selector 를 버리고 허용 패키지만 실행, 임의 URL 로드 없음", () => {
    for (const s of ["isAllowedIntentTarget(", "isSafeIntentDataScheme(", "setComponent(null)", "setSelector(null)", "setFlags(0)", "replaceExtras((android.os.Bundle) null)", "removeCategory(c)", "CATEGORY_BROWSABLE", "marketTargetPackage("]) expect(javaPlugin).toContain(s);
    expect(javaPlugin).not.toMatch(/loadUrl\([^)]*(getData|uri\.toString|raw)\)/);   // 들어온 URL 을 그대로 로드하지 않는다(우리 서버 결과 경로만)
  });
  it("iOS: 복귀·카드 호출은 결제 성공을 말하지 않고, 열 화면은 서버 결과 경로뿐", () => {
    expect(swiftPlugin).toContain("NicepayAppReturn.resultPath(parsed)"); expect(swiftPlugin).toContain("결제는 완료되지 않았어요"); expect(code(swiftPlugin)).not.toMatch(/완료됐어요|결제 성공/);
    expect(javaPlugin).toContain("결제는 완료되지 않았어요"); expect(code(javaPlugin)).not.toMatch(/완료됐어요|결제 성공/);
  });
});

describe("Swift 순수 로직 검사(swiftc 가 있을 때)", () => {
  it("scripts/native/nicepayAppReturnCheck 가 통과한다", () => {
    let has = true; try { execFileSync("swiftc", ["--version"], { stdio: "ignore" }); } catch { has = false; }
    if (!has || !existsSync(path.join(root, "scripts/native/nicepayAppReturnCheck/main.swift"))) return;   // 환경에 없으면 건너뜀(CI 러너는 보통 없음 — 로컬 검증 항목)
    const out = path.join(mkdtempSync(path.join(os.tmpdir(), "npswift-")), "check");
    execFileSync("swiftc", ["-o", out, path.join(root, "ios/App/App/NicepayAppReturn.swift"), path.join(root, "scripts/native/nicepayAppReturnCheck/main.swift")], { stdio: "pipe" });
    expect(execFileSync(out, { encoding: "utf8" })).toContain("OK: NicepayAppReturn swift checks passed");
  }, 180_000);
});
