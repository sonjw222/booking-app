/*
  PaymentProviderFactory가 NEXT_PUBLIC_PAYMENT_PROVIDER 값에 따라
  올바른 구현체를 반환하는지만 검증한다(각 Provider의 실제 동작은 별개로 테스트됨).
*/
import { afterEach, describe, expect, it } from "vitest";
import { getPaymentProvider } from "../../lib/payments/PaymentProviderFactory";
import { MockPaymentProvider } from "../../lib/payments/MockPaymentProvider";
import { NicepayPaymentProvider } from "../../lib/payments/NicepayPaymentProvider";
import { DisabledPaymentProvider } from "../../lib/payments/DisabledPaymentProvider";
import { resolveProviderName, isOnlinePgCheckoutAvailable, NICEPAY_CHECKOUT_ACTIVATED } from "../../lib/payments/PaymentProviderFactory";

const ORIGINAL = process.env.NEXT_PUBLIC_PAYMENT_PROVIDER;

afterEach(() => {
  process.env.NEXT_PUBLIC_PAYMENT_PROVIDER = ORIGINAL;
});

describe("getPaymentProvider", () => {
  it("환경변수가 없으면 MockPaymentProvider를 반환한다(기본값)", () => {
    delete process.env.NEXT_PUBLIC_PAYMENT_PROVIDER;
    expect(getPaymentProvider()).toBeInstanceOf(MockPaymentProvider);
  });

  it("NEXT_PUBLIC_PAYMENT_PROVIDER=mock이면 MockPaymentProvider를 반환한다", () => {
    process.env.NEXT_PUBLIC_PAYMENT_PROVIDER = "mock";
    expect(getPaymentProvider()).toBeInstanceOf(MockPaymentProvider);
  });

  it("NEXT_PUBLIC_PAYMENT_PROVIDER=nicepay이면 NicepayPaymentProvider를 선택하지만 서버·DB 별도 게이트가 결제를 제한한다", () => {
    process.env.NEXT_PUBLIC_PAYMENT_PROVIDER = "nicepay";
    const p = getPaymentProvider();
    expect(p).toBeInstanceOf(NicepayPaymentProvider);
    expect(NICEPAY_CHECKOUT_ACTIVATED).toBe(true);
    expect(isOnlinePgCheckoutAvailable()).toBe(true); // 실제 결제 승인 조건이 아님: 서버 및 DB 게이트는 별개
  });

  it("과거 값 toss/portone은 (개발 환경에서도) mock으로 떨어지지 않고 DisabledPaymentProvider(fail-closed)가 된다", async () => {
    for (const v of ["toss", "portone"]) {
      process.env.NEXT_PUBLIC_PAYMENT_PROVIDER = v;
      expect(resolveProviderName()).toBe("disabled");
      const p = getPaymentProvider();
      expect(p).toBeInstanceOf(DisabledPaymentProvider);
      await expect(p.createPayment({ orderId: "o", amount: 1000 })).rejects.toThrow(/준비 중/);
      await expect(p.confirmPayment("k", "o", 1000)).rejects.toThrow();
      expect(isOnlinePgCheckoutAvailable()).toBe(false);
    }
  });

  it("알 수 없는 값이면 안전하게 MockPaymentProvider로 폴백한다", () => {
    process.env.NEXT_PUBLIC_PAYMENT_PROVIDER = "unknown-provider";
    expect(getPaymentProvider()).toBeInstanceOf(MockPaymentProvider);
  });
});
