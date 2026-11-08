// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import config from "../../capacitor.config";
import { openNicepayV3Window, nicepayV3FormFields, type NicepayV3Params } from "../../lib/payments/nicepayV3Window";

/* iOS 실기기(2026-11-08): 카드 결제창 확인 → 외부 Safari(web.nicepay.co.kr) "일시적인 오류".
   원인 모델: Capacitor iOS WebViewDelegationHandler.decidePolicyFor — allowNavigation 에 없는 호스트로의 최상위 이동은 UIApplication.open(URL) + cancel.
   POST 본문은 넘어가지 않는다. 아래는 그 판정(node_modules/@capacitor/ios 8.5.1 의 doesHost/decidePolicyFor)을 그대로 옮긴 모델이다 — 실제 WKWebView 시험이 아니다(별도 실기기 QA 항목). */
const hosts = (config.server?.allowNavigation ?? []) as string[];
function doesHost(host: string, pattern: string): boolean {   // CAPInstanceConfiguration.doesHost 와 같은 규칙: "*" 전체, 라벨 수가 같아야 하고 "*" 라벨은 건너뜀
  if (pattern === "*") return true;
  const h = host.toLowerCase().split("."), p = pattern.toLowerCase().split(".");
  if (h.length !== p.length) return false;
  return p.every((seg, i) => seg === "*" || seg === h[i]);
}
type Nav = { url: string; method: "GET" | "POST"; topLevel: boolean };
function decide(nav: Nav, allow: string[], serverUrl = "https://mwhabit.com"): { decision: "allow" | "cancel"; openedExternally: boolean; bodyForwarded: false } {
  const u = new URL(nav.url);
  if (allow.some((p) => doesHost(u.hostname, p))) return { decision: "allow", openedExternally: false, bodyForwarded: false };
  const isApp = nav.url.startsWith(serverUrl);
  if (!isApp && nav.topLevel) return { decision: "cancel", openedExternally: true, bodyForwarded: false };   // UIApplication.open(url) — URL 만 전달, POST 본문 없음
  return { decision: "allow", openedExternally: false, bodyForwarded: false };
}
const NICEPAY_HOSTS = ["pg-web.nicepay.co.kr", "dc1-web.nicepay.co.kr", "web.nicepay.co.kr"];
const PREV = hosts.filter((h) => !NICEPAY_HOSTS.includes(h));

describe("NICEPAY 모바일 결제창 이동 — Capacitor allowNavigation", () => {
  it("[수정 전 모델] 목록에 NICEPAY 가 없으면 goPay 의 POST 최상위 이동은 외부로 넘어가고 취소된다(본문 소실)", () => {
    const r = decide({ url: "https://pg-web.nicepay.co.kr/v3/gwPayment.jsp", method: "POST", topLevel: true }, PREV);
    expect(r).toEqual({ decision: "cancel", openedExternally: true, bodyForwarded: false });
  });
  it("[수정 후] 확인된 호스트 3곳으로의 최상위 POST 이동(gwPayment → smartPayment → 결제창)이 WebView 안에서 허용된다", () => {
    for (const url of ["https://pg-web.nicepay.co.kr/v3/gwPayment.jsp", "https://dc1-web.nicepay.co.kr/v3/smart/smartPayment.jsp?NpIntfVer=N3&ServiceCode=GSLB&AcsNoIframe=Y", "https://dc1-web.nicepay.co.kr/v3/smart/billing/payment.jsp", "https://web.nicepay.co.kr/v3/smart/common/error.jsp"]) {
      expect(decide({ url, method: "POST", topLevel: true }, hosts), url).toMatchObject({ decision: "allow", openedExternally: false });
    }
  });
  it("정확한 호스트만 허용 — 와일드카드·다른 NICEPAY 호스트·유사 도메인은 여전히 외부로 처리", () => {
    expect(hosts.filter((h) => /nicepay/i.test(h)).sort()).toEqual([...NICEPAY_HOSTS].sort());
    expect(hosts).not.toContain("*"); expect(hosts.some((h) => h.startsWith("*.nicepay"))).toBe(false);
    for (const url of ["https://webapi.nicepay.co.kr/webapi/pay_process.jsp", "https://dc2-web.nicepay.co.kr/x", "https://nicepay.co.kr.evil.example/x", "https://evilnicepay.co.kr/x", "https://pg-web.nicepay.co.kr.evil.example/x", "https://example.com/"]) {
      expect(decide({ url, method: "POST", topLevel: true }, hosts), url).toMatchObject({ decision: "cancel", openedExternally: true });
    }
  });
  it("기존 허용 목록(소셜 로그인·Supabase)은 그대로이고 앱 자체 이동·하위 프레임 동작은 변하지 않는다", () => {
    expect(PREV).toEqual(["kauth.kakao.com", "*.kakao.com", "nid.naver.com", "*.naver.com", "accounts.google.com", "*.google.com", "appleid.apple.com", "*.apple.com", "bxntqggkfwnhcczsbqtj.supabase.co"]);
    expect(config.server?.url).toBe("https://mwhabit.com"); expect(config.server?.cleartext).toBe(false);
    expect(decide({ url: "https://mwhabit.com/api/payments/nicepay/review-window/return?rt=x", method: "POST", topLevel: true }, hosts).decision).toBe("allow");   // ReturnURL 은 앱 origin
    expect(decide({ url: "https://card-issuer.example/auth", method: "GET", topLevel: false }, hosts).decision).toBe("allow");   // 하위 프레임은 기존대로 통과
  });
});

describe("NICEPAY 모바일 form 제출 구조(goPay 호출 입력)", () => {
  const params: NicepayV3Params = { MID: "nicepay00m", Moid: "33333333-3333-4333-8333-333333333333", Amt: "80000", GoodsName: "11월 수강권", EdiDate: "20261108120000", SignData: "a".repeat(64), ReturnURL: "https://mwhabit.com/api/payments/nicepay/review-window/return?rt=x", PayMethod: "CARD", CharSet: "utf-8" };
  it("form 은 서버가 준 허용 필드만 POST 로 담고 action 은 우리 ReturnURL(모바일은 ReturnURL 필수)이다 — 키·비밀 필드 없음", () => {
    let captured: HTMLFormElement | null = null;
    const win = { goPay: (f: HTMLFormElement) => { captured = f; } } as unknown as Window & { goPay: (f: HTMLFormElement) => void };
    const dispose = openNicepayV3Window(params, { doc: document, win });
    expect(captured).not.toBeNull(); const f = captured as unknown as HTMLFormElement;
    expect(f.method).toBe("post"); expect(f.getAttribute("action")).toBe(params.ReturnURL); expect(f.getAttribute("accept-charset")).toBe("euc-kr");
    expect([...f.querySelectorAll("input")].map((i) => i.name)).toEqual(nicepayV3FormFields(params).map(([k]) => k));
    expect([...f.querySelectorAll("input")].map((i) => i.name).join(",")).not.toMatch(/key|secret/i);
    dispose();
  });
});
