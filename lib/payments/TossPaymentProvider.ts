/*
  TossPaymentProvider - 토스페이먼츠 결제창(v2 SDK) 연동 실제 구현

  ⚠ v1(js.tosspayments.com/v1)이 아니라 v2(js.tosspayments.com/v2/standard)를 쓴다.
  실측 확인(2026-08-25): v1 SDK는 내부적으로 신규 v2 게이트웨이로 넘기는 "v1-adapter"
  호환 레이어를 거치는데, 이 어댑터가 customerKey를 모든 요청에 고정 리터럴 값으로 보내는
  탓에 px-payment-parameters 호출이 매번 COMMON_ERROR(처리 중 오류가 발생했습니다)로
  실패하는 걸 Playwright로 실제 네트워크 요청을 캡처해 확인했다. v2 SDK를 직접 쓰면 우리가
  customerKey를 로그인 사용자별로 정확히 지정할 수 있어 이 문제가 없다.

  흐름 (Mock과 근본적으로 다름 — types.ts의 CreatePaymentResult.redirected 참고):
    1) createPayment(): window.TossPayments(clientKey).payment({customerKey})로 결제 세션을
       만들고 .requestPayment(...)를 호출한다. 성공 시 브라우저를 토스 결제창으로 이동시켜
       Promise가 정상 resolve되지 않는다(페이지 자체가 떠남). 결제창에서 사용자가 결제를
       마치면 브라우저는 successUrl(app/checkout/success)로 리다이렉트된다.
    2) confirmPayment(): successUrl 페이지에서, 쿼리로 받은 paymentKey/orderId/amount로
       호출한다. 시크릿 키가 필요해 브라우저에서 토스 API를 직접 못 부르므로
       app/api/payments/confirm(서버 라우트)을 거친다(lib/payments/tossPaymentApi.ts).
    3) cancelPayment()/getPaymentStatus(): 결제창을 열기 전(주문만 만든) 단계에서
       취소하거나 상태를 조회할 때 사용.

  window.TossPayments는 app/layout.tsx가 <Script src="https://js.tosspayments.com/v2/standard">로
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
import "../tossSdk"; // window.TossPayments 전역 타입 선언(공용, lib/tossSdk.ts 참고)

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
    if (!input.customerKey) {
      throw new Error("로그인 후 결제할 수 있어요");
    }

    const payment = window.TossPayments(getClientKey()).payment({ customerKey: input.customerKey });
    // 간편결제(카카오페이/토스페이)는 method:"CARD" + card.flowMode:"DIRECT" +
    // card.easyPay:"KAKAOPAY"|"TOSSPAY" 조합으로 연다(그 결제사 창으로 바로 이동, 토스
    // 결제수단 선택 화면 생략) — 일반 카드는 card 자체를 생략. method:"TRANSFER"(실시간
    // 계좌이체)는 은행 선택을 토스 결제창 UI가 처리하며, card 파라미터가 아예 없어야 한다
    // — 실측 확인(2026-08-31): `card: undefined`처럼 값만 비워도 키 자체가 남아있으면
    // 토스 v2 SDK가 "card는 정의되지 않은 파라미터입니다"로 즉시 거부한다. 그래서 값이
    // 아니라 키 자체를 조건부로 넣어야 한다(스프레드로 분리).
    await payment.requestPayment({
      method: input.method === "TRANSFER" ? "TRANSFER" : "CARD",
      amount: { value: input.amount, currency: "KRW" },
      orderId: input.orderId,
      orderName: input.orderName ?? "수강권 결제",
      customerEmail: input.customerEmail,
      successUrl: input.successUrl,
      failUrl: input.failUrl,
      ...(input.method !== "TRANSFER" && input.easyPay
        ? { card: { flowMode: "DIRECT", easyPay: input.easyPay } }
        : {}),
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
