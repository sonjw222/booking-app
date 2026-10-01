/*
  회원 "직접결제" 주문 입력 — app/checkout/page.tsx의 direct 분기가 createOrder에 넘기는 값과 같은 모양(쿠폰·포인트 없는 고정 상품).
  함수/RPC 이름을 추측하지 않고 현재 앱 경로(lib/orders.ts createOrder → orders INSERT, 관리자 updateOrderStatus('done') → fulfill_order RPC)를 그대로 쓴다.
*/
export type DirectOrderInput = {
  centerId: string; productId: string; productName: string; amount: number;
  payMethod: "direct"; discountAmount: number; autoBook: false; pointsUsed: 0;
};

export function buildDirectOrderInput(p: { centerId: string; productId: string; productName: string; price: number }): DirectOrderInput {
  return {
    centerId: p.centerId, productId: p.productId, productName: p.productName,
    amount: p.price,            // 쿠폰/포인트 없는 주문의 최종 금액 = 상품가
    payMethod: "direct",        // PG provider를 붙이지 않는다(payment_provider = null)
    discountAmount: 0,          // 이번 QA에서는 쿠폰을 쓰지 않는다(memberCouponId/couponCode 키 자체를 넘기지 않음)
    autoBook: false,
    pointsUsed: 0,
  };
}

// 쿠폰 적용 주문 입력 — checkout direct 분기와 같은 모양: amount = 상품가 - 할인(memberCouponDiscount), discountAmount = 미리보기 할인, memberCouponId = 고른 쿠폰.
// amount/discountAmount는 "클라이언트가 보내는 값"일 뿐이라 변조 시나리오에서 일부러 다르게 넘길 수 있다(서버가 확정 시 다시 계산·검증).
export type CouponOrderInput = Omit<DirectOrderInput, "discountAmount"> & { discountAmount: number; memberCouponId: string };

export function buildCouponOrderInput(p: {
  centerId: string; productId: string; productName: string; price: number; discountAmount: number; memberCouponId: string; amount?: number;
}): CouponOrderInput {
  return {
    ...buildDirectOrderInput({ centerId: p.centerId, productId: p.productId, productName: p.productName, price: p.price }),
    amount: p.amount ?? Math.max(0, p.price - p.discountAmount),
    discountAmount: p.discountAmount,
    memberCouponId: p.memberCouponId,
  };
}
