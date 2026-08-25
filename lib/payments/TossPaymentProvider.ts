/*
  TossPaymentProvider - 토스페이먼츠 결제위젯(v1 SDK) 연동 실제 구현

  흐름 (Mock과 근본적으로 다름 — types.ts의 CreatePaymentResult.redirected 참고):
    1) createPayment(): window.TossPayments(clientKey).requestPayment(...) 호출.
       이 호출은 성공 시 브라우저를 토스 결제창으로 이동시킨다(Promise가 정상 resolve되지
       않음 — 페이지 자체가 떠남). 결제창에서 사용자가 결제를 마치면 브라우저는
       successUrl(app/checkout/success)로 리다이렉트된다.
    2) confirmPayment(): successUrl 페이지에서, 쿼리로 받은 paymentKey/orderId/amount로
       호출한다. 시크릿 키가 필요해 브라우저에서 토스 API를 직접 못 부르므로
       app/api/payments/confirm(서버 라우트)을 거친다(lib/payments/tossPaymentApi.ts).
    3) cancelPayment()/getPaymentStatus(): 결제창을 열기 전(주문만 만든) 단계에서
       취소하거나 상태를 조회할 때 사용.

  window.TossPayments는 app/layout.tsx가 <Script src="https://js.tosspayments.com/v1">로
  전역 로드한다(npm 패키지 설치 없이 토스 공식 가이드 방식).
*/

import type {
  CancelPaymentResult,
  ConfirmPaymentResult,
  CreatePaymentInput,
  CreatePaymentResult,
  PaymentProvider,
  PaymentStatusResult,
} from "./types";
import { cancelRealPaymentApi, confirmRealPaymentApi } from "./tossPaymentApi";
import { fetchOrderPaymentStatus } from "./mockPaymentApi";

declare global {
  interface Window {
    TossPayments?: (clientKey: string) => {
      requestPayment: (
        method: string,
        params: {
          amount: number;
          orderId: string;
          orderName: string;
          customerEmail?: string;
          successUrl: string;
          failUrl: string;
        }
      ) => Promise<void>;
    };
  }
}

function getClientKey(): string {
  const key = process.env.NEXT_PUBLIC_TOSS_CLIENT_KEY;
  if (!key) throw new Error("토스 결제 설정이 없어요(NEXT_PUBLIC_TOSS_CLIENT_KEY)");
  return key;
}

export class TossPaymentProvider implements PaymentProvider {
  async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    if (typeof window === "undefined" || !window.TossPayments) {
      throw new Error("결제 모듈을 아직 불러오지 못했어요. 잠시 후 다시 시도해주세요.");
    }
    if (!input.successUrl || !input.failUrl) {
      throw new Error("결제 리다이렉트 URL이 없어요(successUrl/failUrl)");
    }

    const tossPayments = window.TossPayments(getClientKey());
    // '카드'만 지원(MVP 범위) — 카카오페이/토스페이 같은 간편결제는 결제수단 UI 정비와
    // 별도 확인이 필요해 후속 작업으로 남긴다(docs/TODO.md 참고).
    await tossPayments.requestPayment("카드", {
      amount: input.amount,
      orderId: input.orderId,
      orderName: input.orderName ?? "수강권 결제",
      customerEmail: input.customerEmail,
      successUrl: input.successUrl,
      failUrl: input.failUrl,
    });

    // 위 호출이 성공하면 브라우저가 결제창으로 이동해 이 아래 코드는 실행되지 않는다.
    // (사용자가 결제창을 즉시 닫는 등 실패 시엔 reject되어 catch로 넘어감 — 호출부가 처리)
    return { paymentKey: "", status: "pending", redirected: true };
  }

  async confirmPayment(paymentKey: string, orderId: string, amount?: number): Promise<ConfirmPaymentResult> {
    if (typeof amount !== "number") {
      throw new Error("토스 결제 확정에는 결제 금액(amount)이 필요해요");
    }
    const { membershipId } = await confirmRealPaymentApi(paymentKey, orderId, amount);
    return { status: "paid", membershipId: membershipId ?? undefined };
  }

  async cancelPayment(orderId: string): Promise<CancelPaymentResult> {
    await cancelRealPaymentApi(orderId);
    return { status: "cancelled" };
  }

  async getPaymentStatus(orderId: string): Promise<PaymentStatusResult> {
    const status = await fetchOrderPaymentStatus(orderId);
    return { orderId, status };
  }
}
