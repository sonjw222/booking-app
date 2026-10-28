import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { getLegacyProvider, getPaymentProvider, resolveProviderName, LEGACY_PG_CHECKOUT_ACTIVATED, NICEPAY_CHECKOUT_ACTIVATED } from "../../lib/payments/PaymentProviderFactory";
import { TossPaymentProvider } from "../../lib/payments/TossPaymentProvider";
import { PortOnePaymentProvider } from "../../lib/payments/PortOnePaymentProvider";
import { DisabledPaymentProvider } from "../../lib/payments/DisabledPaymentProvider";
import { NicepayPaymentProvider } from "../../lib/payments/NicepayPaymentProvider";

const r = (f: string) => path.resolve(__dirname, "../..", f);
const ENV = { P: process.env.NEXT_PUBLIC_PAYMENT_PROVIDER, A: process.env.NEXT_PUBLIC_ALLOW_MOCK_PAYMENT };
afterEach(() => { for (const [k, v] of [["NEXT_PUBLIC_PAYMENT_PROVIDER", ENV.P], ["NEXT_PUBLIC_ALLOW_MOCK_PAYMENT", ENV.A]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

describe("레거시 PG(Toss/PortOne) 어댑터 보존 — 다시 켜지지 않는다", () => {
  it("어댑터 클래스·과거 거래 서버 경로 파일이 남아 있다", () => {
    for (const f of ["lib/payments/TossPaymentProvider.ts", "lib/payments/PortOnePaymentProvider.ts", "lib/payments/tossPaymentApi.ts", "lib/payments/server/toss.ts", "app/api/payments/confirm/route.ts", "app/api/payments/cancel/route.ts", "app/api/payments/refund/route.ts", "app/api/payments/return/confirm/route.ts", "app/api/payments/return/cancel/route.ts", "app/api/payments/return-token/route.ts", "app/checkout/success/page.tsx", "app/checkout/fail/page.tsx"]) expect(existsSync(r(f)), f).toBe(true);
    expect(new TossPaymentProvider()).toBeInstanceOf(TossPaymentProvider); expect(new PortOnePaymentProvider()).toBeInstanceOf(PortOnePaymentProvider);
  });
  it("환경변수 toss/portone 은 어떤 환경에서도 레거시 어댑터가 되지 않고(disabled), mock 으로도 떨어지지 않는다", () => {
    for (const v of ["toss", "portone"]) for (const allow of [undefined, "true"]) {
      process.env.NEXT_PUBLIC_PAYMENT_PROVIDER = v; if (allow) process.env.NEXT_PUBLIC_ALLOW_MOCK_PAYMENT = allow; else delete process.env.NEXT_PUBLIC_ALLOW_MOCK_PAYMENT;
      expect(resolveProviderName()).toBe("disabled"); const p = getPaymentProvider();
      expect(p).toBeInstanceOf(DisabledPaymentProvider); expect(p).not.toBeInstanceOf(TossPaymentProvider); expect(p).not.toBeInstanceOf(PortOnePaymentProvider);
    }
  });
  it("알 수 없는 값(오타 포함)은 운영 빌드에서 mock 이 아니라 disabled, nicepay 는 NICEPAY 어댑터", () => {
    process.env.NEXT_PUBLIC_PAYMENT_PROVIDER = "nicepaay"; delete process.env.NEXT_PUBLIC_ALLOW_MOCK_PAYMENT;
    const nodeEnv = process.env.NODE_ENV; (process.env as Record<string, string>).NODE_ENV = "production";
    try { expect(resolveProviderName()).toBe("disabled"); process.env.NEXT_PUBLIC_PAYMENT_PROVIDER = "nicepay"; expect(getPaymentProvider()).toBeInstanceOf(NicepayPaymentProvider); } finally { (process.env as Record<string, string>).NODE_ENV = nodeEnv as string; }
  });
  it("레거시 활성 상수와 NICEPAY 활성 상수는 모두 false, 상수가 false 인 동안 getLegacyProvider 는 항상 Disabled", () => {
    expect(LEGACY_PG_CHECKOUT_ACTIVATED).toBe(false); expect(NICEPAY_CHECKOUT_ACTIVATED).toBe(false);
    expect(getLegacyProvider("toss")).toBeInstanceOf(DisabledPaymentProvider); expect(getLegacyProvider("portone")).toBeInstanceOf(DisabledPaymentProvider);
  });
  it("체크아웃은 레거시 어댑터를 직접 참조하지 않는다(신규 결제 경로에 토스/포트원이 없음)", () => {
    expect(readFileSync(r("app/checkout/page.tsx"), "utf8")).not.toMatch(/TossPaymentProvider|PortOnePaymentProvider|loadTossSdk/);
  });
});
