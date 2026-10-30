import { afterEach, describe, expect, it, vi } from "vitest";
import { getActiveNicepayConfig } from "../../lib/payments/server/nicepay/runtime";
import { methodsForProvider, visiblePayMethodIds } from "../../lib/payMethods";

/* 카드사 심사 준비 브랜치: 코드 잠금만 열고 서버 환경·DB 모드는 분리. 공개 PG는 기본 OFF이며 운영 실결제 설정을 절대 변경하지 않는다. */
const KEYS = ["NEXT_PUBLIC_PAYMENT_PROVIDER", "NEXT_PUBLIC_PG_CHECKOUT_ENABLED", "NEXT_PUBLIC_ALLOW_MOCK_PAYMENT"] as const;
const SAVED = Object.fromEntries(KEYS.map((k) => [k, process.env[k]])); const NODE_ENV = process.env.NODE_ENV;
afterEach(() => { for (const k of KEYS) { if (SAVED[k] === undefined) delete process.env[k]; else process.env[k] = SAVED[k]; } (process.env as Record<string, string>).NODE_ENV = NODE_ENV as string; vi.resetModules(); });
const asProduction = (env: Partial<Record<(typeof KEYS)[number], string>>) => { (process.env as Record<string, string>).NODE_ENV = "production"; for (const k of KEYS) delete process.env[k]; for (const [k, v] of Object.entries(env)) process.env[k] = v as string; vi.resetModules(); };
const FULL_ENV = { NICEPAY_CHECKOUT_ENABLED: "true", NICEPAY_API_FAMILY: "v3_mid", NICEPAY_ENV: "production", NICEPAY_MID: "m", NICEPAY_MERCHANT_KEY: "k", NICEPAY_RETURN_BASE_URL: "https://app.example.test", PAYMENT_RETURN_TOKEN_SECRET: "s" };

describe("카드사 심사 준비 — 클라이언트·서버·DB 단계별 제어", () => {
  it("운영 빌드에 환경변수가 전혀 없으면 결제 제공자 disabled, PG 수단 OFF, mock 결제 금지", async () => {
    asProduction({}); const f = await import("../../lib/payments/PaymentProviderFactory");
    expect(f.resolveProviderName()).toBe("disabled"); expect(f.isOnlinePgCheckoutAvailable()).toBe(false); expect(f.PG_CHECKOUT_ENABLED).toBe(false);
    const p = f.getPaymentProvider(); const d = await import("../../lib/payments/DisabledPaymentProvider"); expect(p).toBeInstanceOf(d.DisabledPaymentProvider);
    await expect(p.createPayment({ orderId: "o", amount: 1000, orderName: "x", successUrl: "u", failUrl: "u" } as never)).rejects.toThrow();
  });
  it("provider=nicepay 로 선택해도 서버 스위치 OFF면 결제 API는 503; 일반 회원에게 카드 UI도 노출하지 않음", async () => {
    asProduction({ NEXT_PUBLIC_PAYMENT_PROVIDER: "nicepay", NEXT_PUBLIC_PG_CHECKOUT_ENABLED: "false" });
    const f = await import("../../lib/payments/PaymentProviderFactory");
    expect(f.NICEPAY_CHECKOUT_ACTIVATED).toBe(true); expect(f.resolveProviderName()).toBe("nicepay");
    expect(f.PG_CHECKOUT_ENABLED).toBe(false); expect(f.isOnlinePgCheckoutAvailable()).toBe(true);
    expect(getActiveNicepayConfig({ ...FULL_ENV, NICEPAY_CHECKOUT_ENABLED: "false" })).toMatchObject({ active: false, status: 503 });
    const all = methodsForProvider(["card", "kakao", "toss", "transfer", "direct"], "nicepay");
    expect(visiblePayMethodIds({ pgEnabled: false, allowed: null, all })).toEqual(["direct"]);
    expect(visiblePayMethodIds({ pgEnabled: true, allowed: null, all })).toEqual(["card", "direct"]);
  });
  it("서버 설정 하나라도 없으면 결제 API 비활성, complete 설정은 별도 심사 승인 후 사용", () => {
    expect(getActiveNicepayConfig({ ...FULL_ENV, NICEPAY_CHECKOUT_ENABLED: "false" }).active).toBe(false);
    expect(getActiveNicepayConfig({ ...FULL_ENV, NICEPAY_API_FAMILY: undefined }).active).toBe(false);
    expect(getActiveNicepayConfig({ ...FULL_ENV, NICEPAY_RETURN_BASE_URL: "" }).active).toBe(false);
  });
  it("PG 공개 플래그는 정확히 true 일 때만 켜짐, Toss/PortOne 은 신규 결제 불가", async () => {
    asProduction({ NEXT_PUBLIC_PG_CHECKOUT_ENABLED: "TRUE" }); const f = await import("../../lib/payments/PaymentProviderFactory");
    expect(f.PG_CHECKOUT_ENABLED).toBe(false); expect(f.LEGACY_PG_CHECKOUT_ACTIVATED).toBe(false); expect(f.NICEPAY_CHECKOUT_ACTIVATED).toBe(true);
  });
  it("toss·portone·오타 값은 mock 또는 레거시로 우회하지 않는다", async () => {
    for (const v of ["toss", "portone", "nicepaay", "NICEPAY", "mock "]) { asProduction({ NEXT_PUBLIC_PAYMENT_PROVIDER: v }); const f = await import("../../lib/payments/PaymentProviderFactory"); expect(f.resolveProviderName(), v).toBe("disabled"); }
  });
});
