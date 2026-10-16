/*
  NicepayPaymentProvider - 구조만 준비(비활성). PaymentProviderFactory에 연결되지 않았고 resolveProviderName()도 "nicepay"를 반환하지 않는다.
  활성화에 필요한 것(별도 승인 + 계약 후): 가맹점 MID/MerchantKey, orders_payment_provider_check에 'nicepay' 추가(SQL, 승인 필요),
  결제창 SDK 호출(공식 문서: nicepay-pgweb.js goPay), returnUrl 서버 라우트 → lib/payments/server/nicepay/lifecycle.ts. 설계는 docs/payments/NICEPAY_REVIEW_PREPARATION.md.
  가짜 결제창을 만들지 않는다: 모든 메서드는 명시적으로 throw한다.
*/
import type { CancelPaymentResult, ConfirmPaymentResult, CreatePaymentInput, CreatePaymentResult, PaymentProvider, PaymentStatusResult } from "./types";

const NOT_ACTIVE = "NicepayPaymentProvider는 아직 활성화되지 않았어요 (가맹점 계약·MID/KEY 필요)";

export class NicepayPaymentProvider implements PaymentProvider {
  async createPayment(_input: CreatePaymentInput): Promise<CreatePaymentResult> { throw new Error(NOT_ACTIVE); }
  async confirmPayment(_paymentKey: string, _orderId: string, _amount?: number): Promise<ConfirmPaymentResult> { throw new Error(NOT_ACTIVE); }
  async cancelPayment(_orderId: string): Promise<CancelPaymentResult> { throw new Error(NOT_ACTIVE); }
  async getPaymentStatus(_orderId: string): Promise<PaymentStatusResult> { throw new Error(NOT_ACTIVE); }
}
