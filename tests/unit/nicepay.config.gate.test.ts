// @vitest-environment node
/* NICEPAY 활성 조건(fail-closed)·라우트 비활성 차단·플래그 분리 — 환경변수를 바꾸지 않는다(테스트 안에서 임시 env 객체/프로세스 env 복원). */
import { describe, expect, it, vi } from "vitest";
import { loadNicepayConfig } from "../../lib/payments/server/nicepay/config";
import { getActiveNicepayConfig } from "../../lib/payments/server/nicepay/runtime";
import { NICEPAY_CHECKOUT_ACTIVATED, resolveProviderName, isOnlinePgCheckoutAvailable } from "../../lib/payments/PaymentProviderFactory";

const REST_ENV = { NICEPAY_CHECKOUT_ENABLED: "true", NICEPAY_API_FAMILY: "rest_v1", NICEPAY_ENV: "sandbox", NICEPAY_CLIENT_ID: "S2_x", NICEPAY_SECRET_KEY: "k", NICEPAY_RETURN_BASE_URL: "https://app.example.test", PAYMENT_RETURN_TOKEN_SECRET: "s" };
const V3_ENV = { NICEPAY_CHECKOUT_ENABLED: "true", NICEPAY_API_FAMILY: "v3_mid", NICEPAY_ENV: "production", NICEPAY_MID: "m", NICEPAY_MERCHANT_KEY: "k", NICEPAY_RETURN_BASE_URL: "https://app.example.test/", PAYMENT_RETURN_TOKEN_SECRET: "s" };

describe("활성 조건 — 4가지가 모두 참이어야만 활성", () => {
  it("코드가 심사 전용으로 준비돼도 서버 스위치가 꺼지면 비활성(503, 외부 호출 전 중단)", () => {
    expect(NICEPAY_CHECKOUT_ACTIVATED).toBe(true);
    const disabled = { ...REST_ENV, NICEPAY_CHECKOUT_ENABLED: "false" };
    expect(loadNicepayConfig(disabled)).toEqual({ ok: false, reason: "disabled", missing: [] });
    expect(getActiveNicepayConfig(disabled).active).toBe(false);
  });
  it("서버 활성 변수(NICEPAY_CHECKOUT_ENABLED)는 정확히 'true'일 때만", () => {
    for (const v of [undefined, "", "1", "TRUE", "yes", "false"]) expect(loadNicepayConfig({ ...REST_ENV, NICEPAY_CHECKOUT_ENABLED: v }, { codeFlag: true })).toMatchObject({ ok: false, reason: "disabled" });
  });
  it("Toss 시절 플래그(NEXT_PUBLIC_PG_CHECKOUT_ENABLED)는 NICEPAY를 켜지 않는다", () => {
    expect(loadNicepayConfig({ NEXT_PUBLIC_PG_CHECKOUT_ENABLED: "true", ...REST_ENV, NICEPAY_CHECKOUT_ENABLED: undefined }, { codeFlag: true })).toMatchObject({ ok: false, reason: "disabled" });
    expect(loadNicepayConfig({ NEXT_PUBLIC_PG_CHECKOUT_ENABLED: "true" }, { codeFlag: true })).toMatchObject({ ok: false });
  });
  it("계열/환경/키/반환 URL/복귀 토큰 비밀 중 하나라도 없으면 incomplete(어떤 항목이 비었는지 이름만 알려준다, 값 없음)", () => {
    for (const [k, v] of [["NICEPAY_API_FAMILY", undefined], ["NICEPAY_API_FAMILY", "v2"], ["NICEPAY_ENV", undefined], ["NICEPAY_ENV", "prod"], ["NICEPAY_CLIENT_ID", ""], ["NICEPAY_SECRET_KEY", "  "], ["NICEPAY_RETURN_BASE_URL", "http://insecure.test"], ["NICEPAY_RETURN_BASE_URL", "https://x.test/path"], ["PAYMENT_RETURN_TOKEN_SECRET", undefined]] as const) {
      const r = loadNicepayConfig({ ...REST_ENV, [k]: v }, { codeFlag: true });
      expect(r.ok).toBe(false); expect(r).toMatchObject({ reason: "incomplete" }); expect(JSON.stringify(r)).not.toContain("S2_x");
    }
    expect(loadNicepayConfig({ ...V3_ENV, NICEPAY_MID: undefined }, { codeFlag: true })).toMatchObject({ ok: false, missing: ["NICEPAY_MID"] });
    // 계열이 rest인데 v3 키만 있으면 비활성(키 계열을 추측하지 않는다)
    expect(loadNicepayConfig({ ...V3_ENV, NICEPAY_API_FAMILY: "rest_v1" }, { codeFlag: true })).toMatchObject({ ok: false, reason: "incomplete" });
  });
  it("완전한 설정이면 계열별로 활성(코드 상수가 켜졌다고 가정한 경우)이고 환경에 따라 REST 호스트가 정해진다", () => {
    const r = loadNicepayConfig(REST_ENV, { codeFlag: true }); expect(r.ok).toBe(true);
    if (r.ok && r.config.family === "rest_v1") { expect(r.config.apiBase).toBe("https://sandbox-api.nicepay.co.kr"); expect(r.config.sdkUrl).toBe("https://sandbox-pay.nicepay.co.kr/v1/js/"); }
    const p = loadNicepayConfig({ ...REST_ENV, NICEPAY_ENV: "production" }, { codeFlag: true });
    if (p.ok && p.config.family === "rest_v1") expect(p.config.apiBase).toBe("https://api.nicepay.co.kr");
    const v = loadNicepayConfig(V3_ENV, { codeFlag: true }); expect(v.ok && v.config.returnBaseUrl).toBe("https://app.example.test");
  });
  it("클라이언트 팩토리는 nicepay 를 선택할 수 있지만 서버 환경 및 DB 승인 없이 결제 성공을 뜻하지 않는다", () => {
    const prev = process.env.NEXT_PUBLIC_PAYMENT_PROVIDER; process.env.NEXT_PUBLIC_PAYMENT_PROVIDER = "nicepay";
    try {
      expect(resolveProviderName()).toBe("nicepay");
      expect(isOnlinePgCheckoutAvailable()).toBe(true);
      expect(getActiveNicepayConfig({ ...REST_ENV, NICEPAY_CHECKOUT_ENABLED: "false" }).active).toBe(false);
    } finally { if (prev === undefined) delete process.env.NEXT_PUBLIC_PAYMENT_PROVIDER; else process.env.NEXT_PUBLIC_PAYMENT_PROVIDER = prev; }
  });
});

describe("서버 설정이 비어 있는 경우 비활성 결제 차단 — NICEPAY 라우트 503, PG 호출 없음", () => {
  const post = (path: string, body: unknown, headers: Record<string, string> = {}, form = false) => new Request(`http://localhost${path}`, { method: "POST", headers: form ? headers : { "Content-Type": "application/json", ...headers }, body: form ? (body as FormData) : JSON.stringify(body) });
  it.each([
    ["prepare", () => import("../../app/api/payments/nicepay/prepare/route")],
    ["status", () => import("../../app/api/payments/nicepay/status/route")],
    ["abandon", () => import("../../app/api/payments/nicepay/abandon/route")],
    ["webhook", () => import("../../app/api/payments/nicepay/webhook/route")],
    ["return", () => import("../../app/api/payments/nicepay/return/route")],
  ])("%s", async (name, load) => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const m = await load();
    const fd = new FormData(); fd.set("authResultCode", "0000"); fd.set("orderId", "o"); fd.set("tid", "t");
    const res = (await m.POST(name === "return" ? post("/api/payments/nicepay/return?rt=x", fd, {}, true) : post(`/api/payments/nicepay/${name}`, { orderId: "o", amount: 1 }, { Authorization: "Bearer x" }))) as Response;
    expect(res.status).toBe(503);
    const body = await res.text(); expect(body).toContain("nicepay_not_active"); expect(body).not.toMatch(/KEY|SECRET|clientId/i);
    expect(fetchSpy).not.toHaveBeenCalled(); fetchSpy.mockRestore();
  });
  it("승인 후 취소/환불 경로: 핸들러가 주입되지 않으면 NICEPAY 환불은 501 — buildDeps는 비활성에서 nicepayRefund를 붙이지 않는다", async () => {
    const { buildNicepayRefund } = await import("../../lib/payments/server/nicepay/runtime");
    expect(buildNicepayRefund({} as never, { refundBegin: async () => ({ state: "locked" }), refundRelease: async () => ({ data: null, error: null }), dbRefund: async () => ({ data: null, error: null }) }, { ...REST_ENV, NICEPAY_CHECKOUT_ENABLED: "false" })).toBeUndefined();
  });
  it("복귀 주소: http://localhost 는 sandbox 에서만 허용(production·다른 http 호스트는 거부)", () => {
    const base = { ...V3_ENV, NICEPAY_ENV: "sandbox", NICEPAY_RETURN_BASE_URL: "http://localhost:3000" };
    expect(loadNicepayConfig(base, { codeFlag: true }).ok).toBe(true);
    expect(loadNicepayConfig({ ...base, NICEPAY_ENV: "production" }, { codeFlag: true }).ok).toBe(false);
    expect(loadNicepayConfig({ ...base, NICEPAY_RETURN_BASE_URL: "http://127.0.0.1:3000" }, { codeFlag: true }).ok).toBe(false);
    expect(loadNicepayConfig({ ...base, NICEPAY_RETURN_BASE_URL: "http://evil.test" }, { codeFlag: true }).ok).toBe(false);
  });
});
