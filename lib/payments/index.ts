/*
  lib/payments 공개 API
  - 외부(app/*)는 이 파일만 import한다. Provider 구체 클래스를 직접 import하지 않는다.
*/

import { PaymentService } from "./PaymentService";
import { getPaymentProvider } from "./PaymentProviderFactory";
import type { PaymentScenario } from "./types";

// scenarioOverride: Mock 시나리오를 재빌드 없이 즉시 바꾸고 싶을 때 사용
// (예: checkout 화면의 ?mockScenario=failed 쿼리 파라미터)
export function getPaymentService(scenarioOverride?: PaymentScenario): PaymentService {
  return new PaymentService(getPaymentProvider(scenarioOverride));
}

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
