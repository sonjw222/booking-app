/*
  PaymentProviderFactory - PaymentService가 구체 Provider를 직접 생성하지 않도록
  선택/조립 책임을 전담하는 곳 (DIP 유지의 핵심)

  NEXT_PUBLIC_PAYMENT_PROVIDER 값만 바꾸면 mock → toss → portone 전환.
  provider 선택 자체는 클라이언트 번들에서 읽으므로 NEXT_PUBLIC_ 접두사를 유지한다.
  시크릿 키(TOSS_SECRET_KEY 등)는 app/api/payments/*(서버 전용) 라우트에서만 읽는다.
*/

import type { PaymentProvider, PaymentScenario } from "./types";
import { MockPaymentProvider } from "./MockPaymentProvider";
import { TossPaymentProvider } from "./TossPaymentProvider";
import { PortOnePaymentProvider } from "./PortOnePaymentProvider";

export type PaymentProviderName = "mock" | "toss" | "portone";

export function resolveProviderName(): PaymentProviderName {
  const raw = process.env.NEXT_PUBLIC_PAYMENT_PROVIDER;
  if (raw === "toss" || raw === "portone") return raw;
  return "mock";
}

// mockScenarioOverride: Mock일 때만 의미 있음(예: checkout의 ?mockScenario= 쿼리로
// 재빌드 없이 success/failed/cancelled를 즉시 바꿔 QA하기 위함)
export function getPaymentProvider(mockScenarioOverride?: PaymentScenario): PaymentProvider {
  const name = resolveProviderName();
  switch (name) {
    case "toss":
      return new TossPaymentProvider();
    case "portone":
      return new PortOnePaymentProvider();
    case "mock":
    default:
      return new MockPaymentProvider(mockScenarioOverride);
  }
}
