/*
  lib/payments 공개 API
  - 외부(app/*)는 이 파일만 import한다. Provider 구체 클래스를 직접 import하지 않는다.
*/

import { PaymentService } from "./PaymentService";
import { getPaymentProvider, resolveProviderName, PG_CHECKOUT_ENABLED, type PaymentProviderName } from "./PaymentProviderFactory";
import type { PaymentScenario } from "./types";

// scenarioOverride: Mock 시나리오를 재빌드 없이 즉시 바꾸고 싶을 때 사용
// (예: checkout 화면의 ?mockScenario=failed 쿼리 파라미터)
export function getPaymentService(scenarioOverride?: PaymentScenario): PaymentService {
  return new PaymentService(getPaymentProvider(scenarioOverride));
}

// 현재 활성 provider 이름 — orders.payment_provider에 기록하거나(checkout),
// 화면에 "테스트 결제" 안내를 provider별로 다르게 보여줄 때 사용.
export { resolveProviderName, PG_CHECKOUT_ENABLED, type PaymentProviderName };

export type {
  CancelPaymentResult,
  ConfirmPaymentResult,
  CreatePaymentInput,
  CreatePaymentResult,
  PaymentProvider,
  PaymentScenario,
  PaymentStatus,
  PaymentStatusResult,
} from "./types";
export { PaymentService } from "./PaymentService";
