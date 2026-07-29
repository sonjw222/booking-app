/*
  TossPaymentProvider - 구조만 준비 (P0-1 범위 밖, 실제 구현하지 않음)

  운영 전환 시 채워야 할 것:
  - 생성자에서 Toss Client Key/Secret Key를 env에서 읽음
    (NEXT_PUBLIC_TOSS_CLIENT_KEY / 서버 전용 TOSS_SECRET_KEY — 후자는 웹훅/서버 라우트가
    생긴 뒤에만 사용 가능. 지금처럼 클라이언트 컴포넌트에서 직접 호출하면 안 됨)
  - createPayment(): Toss 결제위젯 SDK로 결제창 호출, paymentKey 발급
  - confirmPayment(): Toss 결제 승인 API 호출(서버 사이드 권장) 후 결과에 따라
    실제 운영용 RPC(예: confirm_real_payment, 신규 — confirm_test_payment는 재사용 안 함)를 호출
  - cancelPayment(): Toss 결제취소 API 호출
  - getPaymentStatus(): Toss 결제조회 API 또는 우리 DB의 orders/payments 상태 조회
  - Webhook Handler(향후, app/api/webhooks/toss/route.ts)가 confirmPayment()를 대신 호출하는
    구조가 되어야 함(비동기 결제 승인)
*/

import type {
  CancelPaymentResult,
  ConfirmPaymentResult,
  CreatePaymentInput,
  CreatePaymentResult,
  PaymentProvider,
  PaymentStatusResult,
} from "./types";

export class TossPaymentProvider implements PaymentProvider {
  async createPayment(_input: CreatePaymentInput): Promise<CreatePaymentResult> {
    throw new Error("TossPaymentProvider는 아직 구현되지 않았어요 (P0-1 범위 밖)");
  }

  async confirmPayment(_paymentKey: string, _orderId: string): Promise<ConfirmPaymentResult> {
    throw new Error("TossPaymentProvider는 아직 구현되지 않았어요 (P0-1 범위 밖)");
  }

  async cancelPayment(_orderId: string): Promise<CancelPaymentResult> {
    throw new Error("TossPaymentProvider는 아직 구현되지 않았어요 (P0-1 범위 밖)");
  }

  async getPaymentStatus(_orderId: string): Promise<PaymentStatusResult> {
    throw new Error("TossPaymentProvider는 아직 구현되지 않았어요 (P0-1 범위 밖)");
  }
}
