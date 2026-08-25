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
  // 실제 PG(토스/포트원) 결제창에만 필요한 값들 — Mock은 무시함.
  // orderName: 결제창에 표시할 상품명. customerEmail: 영수증/알림용(선택).
  // successUrl/failUrl: 결제창에서 돌아올 리다이렉트 URL.
  orderName?: string;
  customerEmail?: string;
  successUrl?: string;
  failUrl?: string;
  // 토스 v2 SDK 전용 — 결제 세션을 특정 고객에게 귀속시키는 값(2~50자). 로그인 사용자의
  // auth uid를 그대로 쓴다. 없으면(비로그인 등) 토스 결제창 자체를 못 연다.
  customerKey?: string;
  // 간편결제 지정(카카오페이/토스페이 등). 생략하면 일반 카드결제. 값은 토스 ENUM 코드
  // (KAKAOPAY/TOSSPAY 등, docs.tosspayments.com/reference/enum-codes 참고) — Mock은 무시함.
  easyPay?: "KAKAOPAY" | "TOSSPAY";
};

export type CreatePaymentResult = {
  // Provider(PG) 쪽에서 이 결제 시도를 식별하는 참조값. 실제 PG는 여기에 자체 거래 id를 담음
  paymentKey: string;
  status: "pending";
  // 실제 PG 결제창 방식(토스 등)은 이 값을 받은 시점에 이미 브라우저가 결제창으로
  // redirect되어(window.location이 떠남) confirmPayment를 이 흐름 안에서 이어서 호출할 수
  // 없다. true면 호출부(checkout)는 여기서 멈추고, 결제창이 successUrl로 돌려보낸 뒤(새
  // 페이지) 그 페이지에서 confirmPayment를 호출해야 한다. Mock/일부 PG는 false(그대로
  // confirmPayment까지 이어감).
  redirected?: boolean;
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
  // amount: 실제 PG(토스 등)는 결제창 successUrl 리다이렉트로 돌아온 금액을 서버가 다시
  // 대조해야 해서 필요함. Mock은 무시함(생략 가능).
  confirmPayment(paymentKey: string, orderId: string, amount?: number): Promise<ConfirmPaymentResult>;
  cancelPayment(orderId: string): Promise<CancelPaymentResult>;
  getPaymentStatus(orderId: string): Promise<PaymentStatusResult>;
}
