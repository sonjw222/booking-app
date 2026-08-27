/*
  전역 window.TossPayments 타입 선언 — 한 곳에서만 선언해야 한다(같은 전역 인터페이스를
  서로 다른 타입으로 두 곳에서 선언하면 TypeScript가 컴파일 에러를 낸다). 일반 회원 결제
  (P0-1, lib/payments/TossPaymentProvider.ts의 requestPayment)와 센터 플랫폼 구독 빌링
  카드 등록(P0-8, lib/centerSubscription.ts의 requestBillingAuth)이 서로 다른 시점에
  독립적으로 만들어지며 각자 이 전역을 선언하다 충돌했다 — 실제 토스 SDK v2의
  `payment()` 객체는 두 메서드를 전부 가지고 있으므로, 그 실제 형태 그대로 한 곳에
  합쳐뒀다.
*/

export type TossRequestPaymentParams = {
  method: "CARD";
  amount: { value: number; currency: "KRW" };
  orderId: string;
  orderName: string;
  customerEmail?: string;
  successUrl: string;
  failUrl: string;
  // 카카오페이/토스페이 등 간편결제를 열 때 card.flowMode:"DIRECT" + card.easyPay:"KAKAOPAY"|"TOSSPAY" 사용
  card?: { flowMode?: "DEFAULT" | "DIRECT"; easyPay?: string };
};

export type TossRequestBillingAuthParams = {
  method: "CARD";
  successUrl: string;
  failUrl: string;
};

export type TossPaymentInstance = {
  requestPayment: (params: TossRequestPaymentParams) => Promise<void>;
  requestBillingAuth: (params: TossRequestBillingAuthParams) => Promise<void>;
};

export type TossPaymentsSdk = {
  payment: (opts: { customerKey: string }) => TossPaymentInstance;
};

declare global {
  interface Window {
    TossPayments?: (clientKey: string) => TossPaymentsSdk;
  }
}
