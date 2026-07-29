/*
  PortOnePaymentProvider - 구조만 준비 (P0-1 범위 밖, 실제 구현하지 않음)

  운영 전환 시 채워야 할 것:
  - 생성자에서 PortOne 가맹점 식별코드/채널키를 env에서 읽음
    (NEXT_PUBLIC_PORTONE_STORE_ID 등 — Secret Key는 서버 전용, 웹훅/서버 라우트가 생긴 뒤에만 사용)
  - createPayment(): PortOne SDK로 결제창 호출, paymentId 발급
  - confirmPayment(): PortOne 결제내역 단건조회로 실제 승인 여부 검증(서버 사이드 권장) 후
    실제 운영용 RPC(예: confirm_real_payment, 신규 — confirm_test_payment는 재사용 안 함) 호출
  - cancelPayment(): PortOne 결제취소 API 호출
  - getPaymentStatus(): PortOne 결제내역 조회 또는 우리 DB의 orders/payments 상태 조회
  - Webhook Handler(향후, app/api/webhooks/portone/route.ts)가 confirmPayment()를 대신 호출하는
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

export class PortOnePaymentProvider implements PaymentProvider {
  async createPayment(_input: CreatePaymentInput): Promise<CreatePaymentResult> {
    throw new Error("PortOnePaymentProvider는 아직 구현되지 않았어요 (P0-1 범위 밖)");
  }

  async confirmPayment(_paymentKey: string, _orderId: string): Promise<ConfirmPaymentResult> {
    throw new Error("PortOnePaymentProvider는 아직 구현되지 않았어요 (P0-1 범위 밖)");
  }

  async cancelPayment(_orderId: string): Promise<CancelPaymentResult> {
    throw new Error("PortOnePaymentProvider는 아직 구현되지 않았어요 (P0-1 범위 밖)");
  }

  async getPaymentStatus(_orderId: string): Promise<PaymentStatusResult> {
    throw new Error("PortOnePaymentProvider는 아직 구현되지 않았어요 (P0-1 범위 밖)");
  }
}
