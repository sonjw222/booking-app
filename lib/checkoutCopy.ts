/* 결제 화면 문구 — "무엇이 일어나는가"를 결제 방식별로 정확히 말한다(UX-11).
   - direct(센터 직접결제): PG를 거치지 않고 주문(pending)만 접수한다. 이번 클릭으로 청구되지 않고, 센터가 결제를 확인하면 이용권이 발급된다.
   - 그 밖(card/kakao/toss/transfer): 실제 온라인 결제창으로 이동하거나 결제를 승인한다.
   서버 동작은 app/checkout/page.tsx handlePay()가 정한다 — 이 모듈은 문구만 정하고 어떤 동작도 바꾸지 않는다. */
export type CheckoutCopy = {
  mode: "order_request" | "online_pay";
  totalLabel: string;
  button: string;
  busyButton: string;
  consent: string;
};

export function checkoutCopy(payMethod: string, amountText: string): CheckoutCopy {
  if (payMethod === "direct") {
    return {
      mode: "order_request",
      totalLabel: "센터에서 결제할 금액",
      button: `주문 접수하기 · ${amountText}`,
      busyButton: "주문 접수 중...",
      consent: "주문 접수 시",
    };
  }
  return { mode: "online_pay", totalLabel: "총 결제 금액", button: `${amountText} 결제하기`, busyButton: "처리 중...", consent: "결제 시" };
}

/** 직접결제 안내문(결제 수단 아래 설명) — 청구 여부·발급 시점을 함께 말한다. */
export const DIRECT_ORDER_GUIDE = "이 버튼은 주문만 접수하고 결제는 하지 않아요. 센터에서 결제를 확인하면 이용권이 발급돼요.";
