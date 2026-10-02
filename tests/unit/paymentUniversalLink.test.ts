/*
  iOS 결제 복귀 Universal Link(2026-10-02) — URL 허용 규칙 / AASA / entitlements / 네이티브 forwarding 보존 / 비저장·비로그 계약.
*/
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LAUNCH_CHECK_FLAG, resolvePaymentCallbackTarget, shouldCheckLaunchUrl } from "../../lib/paymentUniversalLink";
import { AASA, GET } from "../../app/.well-known/apple-app-site-association/route";

const read = (p: string) => readFileSync(join(__dirname, "../..", p), "utf-8");
const Q = "?paymentKey=pk&orderId=o1&amount=1000&returnToken=tok.sig";

describe("URL 허용 규칙", () => {
  it("https://mwhabit.com의 /checkout/success, /checkout/fail만 허용(쿼리 유지, hash 제거)", () => {
    expect(resolvePaymentCallbackTarget(`https://mwhabit.com/checkout/success${Q}`)).toBe(`/checkout/success${Q}`);
    expect(resolvePaymentCallbackTarget("https://mwhabit.com/checkout/fail?code=X&message=m&orderId=o1&returnToken=t")).toBe("/checkout/fail?code=X&message=m&orderId=o1&returnToken=t");
    expect(resolvePaymentCallbackTarget("https://mwhabit.com/checkout/success?a=1#frag")).toBe("/checkout/success?a=1");
  });
  it("http / 다른 도메인 / 서브·접미 도메인 / 다른 path / 임의 외부 path / userinfo / 잘못된 입력은 모두 거부", () => {
    for (const bad of [
      `http://mwhabit.com/checkout/success${Q}`, `https://evil.example/checkout/success${Q}`, "https://mwhabit.com/checkout", "https://mwhabit.com/checkout/success/extra",
      "https://mwhabit.com/checkout/successful", `https://mwhabit.com.evil.example/checkout/success${Q}`, "https://www.mwhabit.com/checkout/success", "https://mwhabit.com/login",
      "https://mwhabit.com@evil.example/checkout/success", "https://user:pw@mwhabit.com/checkout/success", "javascript:alert(1)", "mwhabit://checkout/success", "//evil.example/checkout/success", "/checkout/success", "", "not a url",
    ]) expect(resolvePaymentCallbackTarget(bad)).toBeNull();
    for (const v of [null, undefined, 5, {}]) expect(resolvePaymentCallbackTarget(v)).toBeNull();
  });
  it("반환값은 항상 같은 origin 내부 경로(/로 시작, //·scheme 없음)", () => {
    const t = resolvePaymentCallbackTarget(`https://mwhabit.com/checkout/success${Q}`)!;
    expect(t.startsWith("/") && !t.startsWith("//") && !t.includes("://")).toBe(true);
  });
});

describe("콜드 스타트 getLaunchUrl 세션당 1회(값 저장 없이 boolean 표시)", () => {
  it("첫 호출만 true, 이후 false / storage 오류·없음은 true(안전하게 확인)", () => {
    const mem: Record<string, string> = {};
    const st = { getItem: (k: string) => mem[k] ?? null, setItem: (k: string, v: string) => { mem[k] = v; } };
    expect(shouldCheckLaunchUrl(st)).toBe(true);
    expect(shouldCheckLaunchUrl(st)).toBe(false);
    expect(mem).toEqual({ [LAUNCH_CHECK_FLAG]: "1" });   // URL/토큰은 저장되지 않는다
    expect(shouldCheckLaunchUrl(null)).toBe(true);
    expect(shouldCheckLaunchUrl({ getItem: () => { throw new Error("x"); }, setItem: () => {} })).toBe(true);
  });
});

describe("AASA", () => {
  it("appID = 실제 Team ID(Xcode DEVELOPMENT_TEAM) + com.mwhabit.app, 허용 path는 success/fail 두 개뿐", () => {
    const pbx = read("ios/App/App.xcodeproj/project.pbxproj");
    const team = /DEVELOPMENT_TEAM = ([A-Z0-9]+);/.exec(pbx)![1];
    expect(AASA.applinks.details).toHaveLength(1);
    expect(AASA.applinks.details[0].appIDs).toEqual([`${team}.com.mwhabit.app`]);
    expect(AASA.applinks.details[0].components).toEqual([{ "/": "/checkout/success" }, { "/": "/checkout/fail" }]);
    expect(pbx).toContain("PRODUCT_BUNDLE_IDENTIFIER = com.mwhabit.app;");
  });
  it("엔드포인트: 200 + application/json, redirect 없음, 비밀값 없음", async () => {
    const res = GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    const text = await res.text();
    expect(JSON.parse(text)).toEqual(AASA);
    expect(text).not.toMatch(/secret|token|key/i);
  });
});

describe("네이티브 / JS 연결", () => {
  const ent = read("ios/App/App/App.entitlements");
  const scene = read("ios/App/App/SceneDelegate.swift");
  const boot = read("app/components/CapacitorBootstrap.tsx");
  it("entitlements: applinks:mwhabit.com만 추가, 기존 aps-environment/Apple Sign-In 보존", () => {
    expect(ent).toContain("<key>com.apple.developer.associated-domains</key>");
    expect([...ent.matchAll(/<string>(applinks:[^<]+)<\/string>/g)].map((m) => m[1])).toEqual(["applinks:mwhabit.com"]);
    expect(ent).toContain("<key>aps-environment</key>");
    expect(ent).toContain("<key>com.apple.developer.applesignin</key>");
    expect(read("ios/App/App.xcodeproj/project.pbxproj")).toContain("CODE_SIGN_ENTITLEMENTS = App/App.entitlements;");
  });
  it("SceneDelegate: 기존 GoogleSignIn openURL 처리와 Capacitor continue(userActivity) forwarding 보존, 새 로깅 없음", () => {
    expect(scene).toContain("GIDSignIn.sharedInstance.handle(context.url)");
    expect(scene).toContain("SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)");
    expect(scene).toContain("SceneDelegateProxy.shared.scene(scene, continue: userActivity)");
    expect(scene).not.toMatch(/NSLog|print\(/);
  });
  it("Info.plist에 새 custom URL scheme 없음(기존 Google reversed client scheme만)", () => {
    const plist = read("ios/App/App/Info.plist");
    expect(plist).not.toMatch(/<string>mwhabit<\/string>/);
  });
  it("JS: appUrlOpen + getLaunchUrl 모두 같은 sanitizer를 쓰고, 저장/로그 없음", () => {
    expect(boot).toContain('App.addListener("appUrlOpen", (event) => goPaymentCallback(event?.url));');
    expect(boot).toContain("App.getLaunchUrl().then((r) => goPaymentCallback(r?.url))");
    expect(boot).toContain("resolvePaymentCallbackTarget(raw)");
    expect(boot).toContain("window.location.replace(target)");
    const helper = read("lib/paymentUniversalLink.ts").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(helper).not.toMatch(/console\.|localStorage|setItem\([^)]*(url|token)/i);
    const goFn = boot.slice(boot.indexOf("const goPaymentCallback"), boot.indexOf('App.addListener("backButton"'));
    expect(goFn).not.toMatch(/console\.|localStorage|sessionStorage\.setItem/);
  });
  it("결제 lifecycle/콜백 페이지는 변경하지 않는다(fallback Safari 경로 그대로)", () => {
    expect(read("app/checkout/success/page.tsx")).toContain("scrubCallbackUrl()");
    expect(read("app/checkout/success/page.tsx")).toContain("returnConfirmWithRetry(");
  });
});
