/*
  DisabledPaymentProvider - 은퇴한 PG(Toss/PortOne) 설정이거나 Mock이 허용되지 않은 환경에서 쓰이는 fail-closed Provider.
  신규 결제·확정·취소 시도를 전부 거부한다. 과거 거래의 환불/조회는 서버 라우트가 담당하므로 여기서 처리하지 않는다.
*/
import type { CancelPaymentResult, ConfirmPaymentResult, CreatePaymentInput, CreatePaymentResult, PaymentProvider, PaymentStatusResult } from "./types";

const RETIRED = "온라인 결제는 준비 중이에요. 직접결제를 이용해주세요";

export class DisabledPaymentProvider implements PaymentProvider {
  async createPayment(_input: CreatePaymentInput): Promise<CreatePaymentResult> { throw new Error(RETIRED); }
  async confirmPayment(_paymentKey: string, _orderId: string, _amount?: number): Promise<ConfirmPaymentResult> { throw new Error(RETIRED); }
  async cancelPayment(_orderId: string): Promise<CancelPaymentResult> { throw new Error(RETIRED); }
  async getPaymentStatus(_orderId: string): Promise<PaymentStatusResult> { throw new Error(RETIRED); }
}
