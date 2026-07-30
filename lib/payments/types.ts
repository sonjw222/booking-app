/*
  Payment Adapter Pattern - 공용 타입 + Provider 인터페이스

  이 파일만 보고도 Provider를 하나 새로 만들 수 있어야 한다.
  PaymentService/Checkout은 이 인터페이스만 알고, 구체 구현(Mock/Toss/PortOne)은 모른다(DIP).
*/

// 결제 상태. 운영 PG 전환 후에도 동일한 상태값을 그대로 쓸 수 있도록 orders.status와 맞춰둠
export type PaymentStatus = "pending" | "paid" | "failed" | "cancelled";

// Mock Provider가 시뮬레이션할 수 있는 시나리오 (실제 PG에는 없는, 테스트 전용 개념)
export type PaymentScenario = "success" | "failed" | "cancelled";

export type CreatePaymentInput = {
  orderId: string;
  amount: number;
};

export type CreatePaymentResult = {
  // Provider(PG) 쪽에서 이 결제 시도를 식별하는 참조값. 실제 PG는 여기에 자체 거래 id를 담음
  paymentKey: string;
  status: "pending";
};

export type ConfirmPaymentResult = {
  status: PaymentStatus;
  membershipId?: string;
  message?: string;
};

export type CancelPaymentResult = {
  status: "cancelled";
};

export type PaymentStatusResult = {
  orderId: string;
  status: PaymentStatus;
};

// Checkout/Reservation/Order 쪽 비즈니스 로직은 이 인터페이스만 참조한다.
// Toss/PortOne으로 교체해도 이 계약(메서드 4개)은 그대로 유지된다.
export interface PaymentProvider {
  createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult>;
  confirmPayment(paymentKey: string, orderId: string): Promise<ConfirmPaymentResult>;
  cancelPayment(orderId: string): Promise<CancelPaymentResult>;
  getPaymentStatus(orderId: string): Promise<PaymentStatusResult>;
}
