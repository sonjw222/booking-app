/*
  PaymentProviderFactory가 NEXT_PUBLIC_PAYMENT_PROVIDER 값에 따라
  올바른 구현체를 반환하는지만 검증한다(각 Provider의 실제 동작은 별개로 테스트됨).
*/
import { afterEach, describe, expect, it } from "vitest";
import { getPaymentProvider } from "../../lib/payments/PaymentProviderFactory";
import { MockPaymentProvider } from "../../lib/payments/MockPaymentProvider";
import { TossPaymentProvider } from "../../lib/payments/TossPaymentProvider";
import { PortOnePaymentProvider } from "../../lib/payments/PortOnePaymentProvider";

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

  it("NEXT_PUBLIC_PAYMENT_PROVIDER=toss이면 TossPaymentProvider를 반환한다", () => {
    process.env.NEXT_PUBLIC_PAYMENT_PROVIDER = "toss";
    expect(getPaymentProvider()).toBeInstanceOf(TossPaymentProvider);
  });

  it("NEXT_PUBLIC_PAYMENT_PROVIDER=portone이면 PortOnePaymentProvider를 반환한다", () => {
    process.env.NEXT_PUBLIC_PAYMENT_PROVIDER = "portone";
    expect(getPaymentProvider()).toBeInstanceOf(PortOnePaymentProvider);
  });

  it("알 수 없는 값이면 안전하게 MockPaymentProvider로 폴백한다", () => {
    process.env.NEXT_PUBLIC_PAYMENT_PROVIDER = "unknown-provider";
    expect(getPaymentProvider()).toBeInstanceOf(MockPaymentProvider);
  });
});
