/*
  PaymentService - Checkout이 실제로 호출하는 단일 진입점.
  구체 Provider(Mock/Toss/PortOne)를 절대 직접 참조하지 않고, 생성자로 주입받은
  PaymentProvider 인터페이스로만 접근한다(DIP).
*/

import type {
  CancelPaymentResult,
  ConfirmPaymentResult,
  CreatePaymentInput,
  CreatePaymentResult,
  PaymentProvider,
  PaymentStatusResult,
} from "./types";

export class PaymentService {
  constructor(private readonly provider: PaymentProvider) {}

  createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    return this.provider.createPayment(input);
  }

  confirmPayment(paymentKey: string, orderId: string): Promise<ConfirmPaymentResult> {
    return this.provider.confirmPayment(paymentKey, orderId);
  }

  cancelPayment(orderId: string): Promise<CancelPaymentResult> {
    return this.provider.cancelPayment(orderId);
  }

  getPaymentStatus(orderId: string): Promise<PaymentStatusResult> {
    return this.provider.getPaymentStatus(orderId);
  }
}
