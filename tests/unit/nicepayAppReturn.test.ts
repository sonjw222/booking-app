// @vitest-environment node
/* NICEPAY v3 앱(WebView) 결제 복귀 — 서버 prepare(WapUrl/IspCancelUrl 은 서버 설정이 승인한 경우에만), 결제창 form 검증, 복귀 URL 파서(네이티브가 같은 규칙 구현), 설정 fail-closed.
   실제 NICEPAY 호출 없음. 정확한 scheme/URL 형식은 NICEPAY 확인 전 "제안값"이라 기본 설정에서는 어디에도 실리지 않는다. */
import { describe, expect, it } from "vitest";
import { handlePrepare, type FlowDeps } from "../../lib/payments/server/nicepay/flow";
import { loadNicepayConfig } from "../../lib/payments/server/nicepay/config";
import { validateNicepayV3Params, nicepayV3FormFields } from "../../lib/payments/nicepayV3Window";
import {
  NICEPAY_ANDROID_PACKAGES, NICEPAY_APP_RETURN_PROPOSED_SCHEME, NICEPAY_IOS_SCHEMES, NICEPAY_NEVER_HANDLE_SCHEMES,
  appReturnResultPath, buildAppReturnUrls, isValidAppReturnScheme, parseAppReturnUrl, shouldNavigateOnReturn,
} from "../../lib/payments/nicepayAppReturn";

const ORDER = "22222222-2222-4222-8222-222222222222", OTHER = "33333333-3333-4333-8333-333333333333";
const SCHEME = NICEPAY_APP_RETURN_PROPOSED_SCHEME, RET = "https://app.example.test";
const cfg = (appReturn?: { scheme: string }) => ({ family: "v3_mid" as const, mid: "testmid01m", merchantKey: "TEST_KEY_NOT_REAL", env: "sandbox" as const, returnBaseUrl: RET, ...(appReturn ? { appReturn } : {}) });
const flow = (appReturn?: { scheme: string }): FlowDeps => ({
  config: cfg(appReturn), returnTokenSecret: "rt_secret_for_tests", getAuthUid: async (t: string) => (t === "tok" ? "u1" : null),
  ownedOrder: async (id: string, uid: string) => (id === ORDER && uid === "u1" ? { orderId: ORDER, status: "pending", amount: 12000, provider: "nicepay" } : null), gateAllows: async () => true,
} as unknown as FlowDeps);
const prep = async (appReturn: { scheme: string } | undefined, client?: unknown) => (await handlePrepare({ token: "tok", orderId: ORDER, client }, flow(appReturn))).body.params as Record<string, string>;

describe("scheme 검증", () => {
  it("제안 scheme 은 통과, 예약·충돌·형식 불량은 거부", () => {
    expect(isValidAppReturnScheme(SCHEME)).toBe(true);
    for (const bad of ["http", "https", "intent", "market", "javascript", "capacitor", "kakaotalk", "naversearchthirdlogin", "supertoss", "kb-acp", "ispmobile", "nicepaysample", "nicepayapp", "kakao123456", "com.googleusercontent.apps.123", "MwhabitNicepay", "abc", "1abcdef", "a b c d e f", "", null, undefined, 5]) expect(isValidAppReturnScheme(bad), String(bad)).toBe(false);
    for (const s of NICEPAY_IOS_SCHEMES) expect(isValidAppReturnScheme(s), s).toBe(false);
  });
});

describe("서버 prepare — WapUrl/IspCancelUrl", () => {
  it("기본(앱 복귀 설정 없음): 앱이라고 알려도 어떤 앱 복귀 필드도 없다(NICEPAY 확인 전 비활성)", async () => {
    for (const c of ["ios", "android", undefined, "web"]) { const p = await prep(undefined, c); expect(p.WapUrl).toBeUndefined(); expect(p.IspCancelUrl).toBeUndefined(); }
  });
  it("설정이 켜져 있고 클라이언트가 ios/android 일 때만 — scheme 은 서버 설정, orderId 는 DB 주문", async () => {
    for (const c of ["ios", "android"]) {
      const p = await prep({ scheme: SCHEME }, c);
      expect(p.WapUrl).toBe(`${SCHEME}://nicepay/wap?orderId=${ORDER}`); expect(p.IspCancelUrl).toBe(`${SCHEME}://nicepay/cancel?orderId=${ORDER}`);
      expect(p.MID).toBe("testmid01m"); expect(p.ReturnURL).toMatch(/^https:\/\/app\.example\.test\/api\/payments\/nicepay\/return\?rt=/);   // ReturnURL 은 그대로 HTTPS 서버 경로
    }
  });
  it("일반 브라우저(client 없음/알 수 없는 값)에는 설정이 켜져 있어도 싣지 않는다 — 기존 웹 결제 흐름 유지", async () => {
    for (const c of [undefined, null, "", "web", "IOS", "evil://x", {}, 1]) { const p = await prep({ scheme: SCHEME }, c); expect(p.WapUrl, String(c)).toBeUndefined(); expect(p.IspCancelUrl).toBeUndefined(); }
  });
  it("클라이언트가 보낸 URL/scheme 은 무시된다(요청 본문의 임의 필드로 복귀 주소를 정할 수 없다)", async () => {
    const r = await handlePrepare({ token: "tok", orderId: ORDER, client: "ios", WapUrl: "evil://steal", scheme: "evil" } as never, flow({ scheme: SCHEME }));
    const p = r.body.params as Record<string, string>; expect(p.WapUrl).toBe(`${SCHEME}://nicepay/wap?orderId=${ORDER}`); expect(JSON.stringify(r.body)).not.toContain("evil");
  });
  it("복귀 URL 에 비밀이 없다(복귀 토큰 rt·MerchantKey 미포함)", async () => {
    const p = await prep({ scheme: SCHEME }, "ios");
    for (const u of [p.WapUrl, p.IspCancelUrl]) { expect(u).not.toMatch(/rt=|token|key|secret|session/i); expect(u).not.toContain("TEST_KEY_NOT_REAL"); }
  });
});

describe("설정 loadNicepayConfig — 앱 복귀는 명시 설정일 때만", () => {
  const base = { NICEPAY_CHECKOUT_ENABLED: "true", NICEPAY_API_FAMILY: "v3_mid", NICEPAY_ENV: "sandbox", NICEPAY_RETURN_BASE_URL: RET, PAYMENT_RETURN_TOKEN_SECRET: "s", NICEPAY_MID: "testmid01m", NICEPAY_MERCHANT_KEY: "k" };
  const appReturnOf = (env: Record<string, string>) => { const r = loadNicepayConfig({ ...base, ...env }, { codeFlag: true }); expect(r.ok).toBe(true); return r.ok && r.config.family === "v3_mid" ? r.config.appReturn : "n/a"; };
  it("기본·한쪽만·잘못된 scheme 은 꺼짐, 둘 다 맞으면 켜짐(결제 자체는 영향 없음)", () => {
    expect(appReturnOf({})).toBeUndefined();
    expect(appReturnOf({ NICEPAY_APP_RETURN_ENABLED: "true" })).toBeUndefined();
    expect(appReturnOf({ NICEPAY_APP_RETURN_SCHEME: SCHEME })).toBeUndefined();
    expect(appReturnOf({ NICEPAY_APP_RETURN_ENABLED: "1", NICEPAY_APP_RETURN_SCHEME: SCHEME })).toBeUndefined();
    expect(appReturnOf({ NICEPAY_APP_RETURN_ENABLED: "true", NICEPAY_APP_RETURN_SCHEME: "https" })).toBeUndefined();
    expect(appReturnOf({ NICEPAY_APP_RETURN_ENABLED: "true", NICEPAY_APP_RETURN_SCHEME: "kakaotalk" })).toBeUndefined();
    expect(appReturnOf({ NICEPAY_APP_RETURN_ENABLED: "true", NICEPAY_APP_RETURN_SCHEME: SCHEME })).toEqual({ scheme: SCHEME });
  });
  it("코드 상수 또는 서버 스위치(NICEPAY_CHECKOUT_ENABLED)가 꺼져 있으면 앱 복귀 설정이 있어도 설정 자체가 비활성", () => {
    expect(loadNicepayConfig({ ...base, NICEPAY_APP_RETURN_ENABLED: "true", NICEPAY_APP_RETURN_SCHEME: SCHEME }, { codeFlag: false }).ok).toBe(false);
    expect(loadNicepayConfig({ ...base, NICEPAY_CHECKOUT_ENABLED: "false", NICEPAY_APP_RETURN_ENABLED: "true", NICEPAY_APP_RETURN_SCHEME: SCHEME }, { codeFlag: true }).ok).toBe(false);
  });
});

describe("결제창 form 검증(validateNicepayV3Params)", () => {
  const server = async () => (await handlePrepare({ token: "tok", orderId: ORDER, client: "ios" }, flow({ scheme: SCHEME }))).body.params as Record<string, unknown>;
  const v = (p: Record<string, unknown>, nativeApp: boolean) => validateNicepayV3Params(p, { orderId: ORDER, amount: 12000 }, RET, { nativeApp });
  it("앱: 두 필드가 form 에 실린다 / 웹 브라우저: 있어도 싣지 않는다", async () => {
    const p = await server();
    const app = v(p, true); expect(app.ok).toBe(true);
    if (app.ok) { const names = nicepayV3FormFields(app.params).map(([k]) => k); expect(names).toContain("WapUrl"); expect(names).toContain("IspCancelUrl"); expect(names).toContain("ReturnURL"); }
    const web = v(p, false); expect(web.ok).toBe(true);
    if (web.ok) expect(nicepayV3FormFields(web.params).map(([k]) => k)).not.toContain("WapUrl");
  });
  it("복귀 필드가 없는 기존 응답은 그대로 통과(회귀 없음)", async () => {
    const p = (await handlePrepare({ token: "tok", orderId: ORDER }, flow())).body.params as Record<string, unknown>;
    const r = v(p, true); expect(r.ok).toBe(true); if (r.ok) expect(nicepayV3FormFields(r.params).map(([k]) => k)).toEqual(["MID", "Moid", "Amt", "GoodsName", "EdiDate", "SignData", "ReturnURL", "PayMethod", "CharSet"]);
  });
  it("위조·불일치(다른 주문·다른 scheme·한쪽만·종류 뒤바뀜·추가 쿼리)는 결제창을 열지 않는다", async () => {
    const p = await server();
    const bad: Array<Record<string, unknown>> = [
      { ...p, WapUrl: `${SCHEME}://nicepay/wap?orderId=${OTHER}` },
      { ...p, IspCancelUrl: `${SCHEME}://nicepay/cancel?orderId=${OTHER}` },
      { ...p, WapUrl: `evilapp://nicepay/wap?orderId=${ORDER}` },
      { ...p, IspCancelUrl: `evilapp://nicepay/cancel?orderId=${ORDER}` },
      { ...p, WapUrl: `${SCHEME}://nicepay/cancel?orderId=${ORDER}`, IspCancelUrl: `${SCHEME}://nicepay/wap?orderId=${ORDER}` },
      { ...p, WapUrl: `${SCHEME}://nicepay/wap?orderId=${ORDER}&x=1` },
      { ...p, WapUrl: "https://evil.example/wap" }, { ...p, WapUrl: "javascript:alert(1)" }, { ...p, WapUrl: undefined }, { ...p, IspCancelUrl: undefined },
    ];
    for (const b of bad) expect(v(b, true).ok, JSON.stringify([b.WapUrl, b.IspCancelUrl])).toBe(false);
  });
});

describe("복귀 URL 파서(네이티브가 같은 규칙) — 위조·변형 차단", () => {
  it("정확한 형식만 통과", () => {
    expect(parseAppReturnUrl(`${SCHEME}://nicepay/wap?orderId=${ORDER}`, SCHEME)).toEqual({ kind: "wap", orderId: ORDER });
    expect(parseAppReturnUrl(`${SCHEME}://nicepay/cancel?orderId=${ORDER}`, SCHEME)).toEqual({ kind: "cancel", orderId: ORDER });
  });
  it("다른 scheme·호스트·경로·쿼리·fragment·userinfo·포트·대문자 UUID·길이 초과는 모두 null", () => {
    const bad = [
      `other://nicepay/wap?orderId=${ORDER}`, `${SCHEME}://evil/wap?orderId=${ORDER}`, `${SCHEME}://nicepay/other?orderId=${ORDER}`, `${SCHEME}://nicepay/?orderId=${ORDER}`, `${SCHEME}://nicepay?orderId=${ORDER}`,
      `${SCHEME}://nicepay/wap`, `${SCHEME}://nicepay/wap?orderId=`, `${SCHEME}://nicepay/wap?orderId=${ORDER}&x=1`, `${SCHEME}://nicepay/wap?x=1&orderId=${ORDER}`, `${SCHEME}://nicepay/wap?orderId=${ORDER}#f`,
      `${SCHEME}://user@nicepay/wap?orderId=${ORDER}`, `${SCHEME}://nicepay:80/wap?orderId=${ORDER}`, `${SCHEME}://nicepay/wap?orderId=${"AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE"}`, `${SCHEME}://nicepay/wap?orderId=not-a-uuid`,
      `${SCHEME}://nicepay/wap?orderId=${ORDER}%0d%0a`, `${SCHEME}://nicepay/wap/../cancel?orderId=${ORDER}`, ` ${SCHEME}://nicepay/wap?orderId=${ORDER}`, `${SCHEME}://nicepay/wap?orderId=${ORDER}${"a".repeat(600)}`,
      "javascript:alert(1)", "https://mwhabit.com/wap", "", null, undefined, 1,
    ];
    for (const u of bad) expect(parseAppReturnUrl(u, SCHEME), String(u).slice(0, 80)).toBeNull();
    expect(parseAppReturnUrl(`${SCHEME}://nicepay/wap?orderId=${ORDER}`, "https")).toBeNull();
  });
  it("열 화면은 우리 결제 결과 경로뿐 — 외부 URL/토큰이 따라오지 않는다", () => {
    expect(appReturnResultPath({ kind: "wap", orderId: ORDER })).toBe(`/checkout/nicepay/result?orderId=${ORDER}&app=1`);
    expect(appReturnResultPath({ kind: "cancel", orderId: ORDER })).toBe(`/checkout/nicepay/result?orderId=${ORDER}&app=1&cancel=1`);
  });
  it("진행 중 인증 흐름(NICEPAY·결제 화면)에서는 wap 복귀가 화면을 바꾸지 않고, 콜드 스타트/다른 화면이면 결과 화면으로, cancel 은 항상", () => {
    const H = "mwhabit.com";
    expect(shouldNavigateOnReturn("wap", "https://pg-web.nicepay.co.kr/v3/x", H)).toBe(false);
    expect(shouldNavigateOnReturn("wap", "https://web.nicepay.co.kr/", H)).toBe(false);
    expect(shouldNavigateOnReturn("wap", `https://${H}/checkout?center=1`, H)).toBe(false);
    expect(shouldNavigateOnReturn("wap", `https://${H}/`, H)).toBe(true);
    expect(shouldNavigateOnReturn("wap", null, H)).toBe(true);
    expect(shouldNavigateOnReturn("cancel", "https://pg-web.nicepay.co.kr/v3/x", H)).toBe(true);
  });
});

describe("buildAppReturnUrls", () => {
  it("UUID 가 아니거나 scheme 이 유효하지 않으면 null", () => {
    expect(buildAppReturnUrls(SCHEME, "x")).toBeNull(); expect(buildAppReturnUrls("https", ORDER)).toBeNull(); expect(buildAppReturnUrls(SCHEME, "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE")).toBeNull();
    expect(buildAppReturnUrls(SCHEME, ORDER)).not.toBeNull();
  });
});

describe("허용 목록(공식 3rd 앱 표: 신용카드·공동인증·백신) — 로그인 앱과 겹치지 않는다", () => {
  it("소문자·중복 없음, 로그인/간편결제 scheme·패키지 제외", () => {
    expect(new Set(NICEPAY_IOS_SCHEMES).size).toBe(NICEPAY_IOS_SCHEMES.length); expect(new Set(NICEPAY_ANDROID_PACKAGES).size).toBe(NICEPAY_ANDROID_PACKAGES.length);
    for (const s of NICEPAY_IOS_SCHEMES) { expect(s).toBe(s.toLowerCase()); expect(NICEPAY_NEVER_HANDLE_SCHEMES).not.toContain(s); }
    for (const s of ["kakaotalk", "naversearchthirdlogin", "supertoss", "tauthlink"]) expect(NICEPAY_IOS_SCHEMES).not.toContain(s);
    for (const p of ["com.kakao.talk", "com.nhn.android.search", "viva.republica.toss", "com.nhnent.payapp"]) expect(NICEPAY_ANDROID_PACKAGES).not.toContain(p);
    for (const p of NICEPAY_ANDROID_PACKAGES) expect(p).toMatch(/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/);
    expect(NICEPAY_IOS_SCHEMES).toContain("ispmobile"); expect(NICEPAY_ANDROID_PACKAGES).toContain("kvp.jjy.MispAndroid320");
  });
});
