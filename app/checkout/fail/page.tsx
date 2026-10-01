"use client";

/*
  토스 결제창(TossPaymentProvider.createPayment의 requestPayment)이 실패/취소로 돌아오는
  failUrl. 토스가 code/message 쿼리를 덧붙여 리다이렉트한다 — 원래 조회 중이던 쿼리(센터/
  상품/예약 복귀 정보)는 유지한 채 /checkout으로 되돌려보내 기존 에러 표시(error-toast)를
  그대로 재사용한다.
*/

import { Suspense, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import Loading from "../../components/Loading";
import { cancelMyPendingOrderQuietly } from "../../../lib/orders";

export default function CheckoutFailPage() {
  return (
    <Suspense fallback={<Loading />}>
      <CheckoutFailContent />
    </Suspense>
  );
}

function CheckoutFailContent() {
  const sp = useSearchParams();

  useEffect(() => {
    const message = sp.get("message") ?? "결제가 취소됐어요";
    const failedOrderId = sp.get("orderId");
    const backParams = new URLSearchParams(sp.toString());
    backParams.delete("code");
    backParams.delete("message");
    backParams.delete("orderId");
    backParams.set("paymentError", message);
    // 토스 failUrl은 결제 "승인 전" 실패/취소로만 호출된다. 결제 화면에서 이미 차감한 포인트가 pending 주문에 묶인 채
    // 남지 않도록 이 주문을 취소한다(취소 시 DB 트리거가 포인트를 1회 복원 — 재시도하면 새 주문으로 다시 차감하기 때문).
    // 이미 승인·발급된(done) 주문은 RLS/상태 전이 가드로 취소되지 않는다. 취소 실패와 무관하게 결제 화면으로 돌아간다.
    cancelMyPendingOrderQuietly(failedOrderId).finally(() => {
      window.location.href = `/checkout?${backParams.toString()}`;
    });
    // sp는 마운트 시점 쿼리만 필요
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="app-shell">
      <Loading />
    </div>
  );
}
