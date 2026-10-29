import { afterEach, describe, expect, it, vi } from "vitest";
import { getActiveNicepayConfig } from "../../lib/payments/server/nicepay/runtime";

/* 결제 비활성 매트릭스 — 세 겹의 잠금: ① 코드 상수 NICEPAY_CHECKOUT_ACTIVATED=false ② DB 게이트 off ③ 일반 회원 PG 결제수단 OFF(+ 레거시 PG 상수 false). Preview/Production 빌드에 환경변수가 하나도 없을 때도 결제는 열리지 않는다. */
const KEYS = ["NEXT_PUBLIC_PAYMENT_PROVIDER", "NEXT_PUBLIC_PG_CHECKOUT_ENABLED", "NEXT_PUBLIC_ALLOW_MOCK_PAYMENT"] as const;
const SAVED = Object.fromEntries(KEYS.map((k) => [k, process.env[k]])); const NODE_ENV = process.env.NODE_ENV;
afterEach(() => { for (const k of KEYS) { if (SAVED[k] === undefined) delete process.env[k]; else process.env[k] = SAVED[k]; } (process.env as Record<string, string>).NODE_ENV = NODE_ENV as string; vi.resetModules(); });
const asProduction = (env: Partial<Record<(typeof KEYS)[number], string>>) => { (process.env as Record<string, string>).NODE_ENV = "production"; for (const k of KEYS) delete process.env[k]; for (const [k, v] of Object.entries(env)) process.env[k] = v as string; vi.resetModules(); };
const FULL_ENV = { NICEPAY_CHECKOUT_ENABLED: "true", NICEPAY_API_FAMILY: "v3_mid", NICEPAY_ENV: "production", NICEPAY_MID: "m", NICEPAY_MERCHANT_KEY: "k", NICEPAY_RETURN_BASE_URL: "https://app.example.test", PAYMENT_RETURN_TOKEN_SECRET: "s" };

describe("결제 비활성 — 코드 상수·환경변수·PG 플래그 조합", () => {
  it("Preview/Production 빌드, 환경변수 전혀 없음: provider=disabled, 온라인 PG 불가, PG 결제수단 OFF, 모든 결제 시도 거부(mock 아님)", async () => {
    asProduction({}); const f = await import("../../lib/payments/PaymentProviderFactory");
    expect(f.resolveProviderName()).toBe("disabled"); expect(f.isOnlinePgCheckoutAvailable()).toBe(false); expect(f.PG_CHECKOUT_ENABLED).toBe(false);
    const p = f.getPaymentProvider(); const d = await import("../../lib/payments/DisabledPaymentProvider"); expect(p).toBeInstanceOf(d.DisabledPaymentProvider);
    await expect(p.createPayment({ orderId: "o", amount: 1000, orderName: "x", successUrl: "u", failUrl: "u" } as never)).rejects.toThrow();
  });
  it("provider=nicepay 로 환경변수를 켜도 코드 상수가 false 면 결제창 불가(isOnlinePgCheckoutAvailable=false), 어댑터는 모든 호출을 거부", async () => {
    asProduction({ NEXT_PUBLIC_PAYMENT_PROVIDER: "nicepay" }); const f = await import("../../lib/payments/PaymentProviderFactory");
    expect(f.NICEPAY_CHECKOUT_ACTIVATED).toBe(false); expect(f.resolveProviderName()).toBe("nicepay"); expect(f.isOnlinePgCheckoutAvailable()).toBe(false);
    await expect(f.getPaymentProvider().createPayment({ orderId: "o", amount: 1000, orderName: "x", successUrl: "u", failUrl: "u" } as never)).rejects.toThrow(/활성화되지 않았/);
  });
  it("서버 설정(NICEPAY_* 전부)이 완전해도 코드 상수 false 면 서버 경로(prepare/return)는 비활성(503)", () => {
    const a = getActiveNicepayConfig(FULL_ENV); expect(a.active).toBe(false); if (!a.active) expect(a.status).toBe(503);
  });
  it("PG 공개 플래그(NEXT_PUBLIC_PG_CHECKOUT_ENABLED)는 값이 없거나 'true' 가 아니면 꺼짐, 레거시 PG 상수·NICEPAY 상수는 false", async () => {
    asProduction({ NEXT_PUBLIC_PG_CHECKOUT_ENABLED: "TRUE" }); const f = await import("../../lib/payments/PaymentProviderFactory");
    expect(f.PG_CHECKOUT_ENABLED).toBe(false); expect(f.LEGACY_PG_CHECKOUT_ACTIVATED).toBe(false); expect(f.NICEPAY_CHECKOUT_ACTIVATED).toBe(false);
  });
  it("toss·portone·오타 값은 어떤 조합에서도 mock/레거시 어댑터가 되지 않는다(disabled)", async () => {
    for (const v of ["toss", "portone", "nicepaay", "NICEPAY", "mock "]) { asProduction({ NEXT_PUBLIC_PAYMENT_PROVIDER: v }); const f = await import("../../lib/payments/PaymentProviderFactory"); expect(f.resolveProviderName(), v).toBe("disabled"); }
  });
});
