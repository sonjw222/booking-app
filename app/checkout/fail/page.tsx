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
    const backParams = new URLSearchParams(sp.toString());
    backParams.delete("code");
    backParams.delete("message");
    backParams.delete("orderId");
    backParams.set("paymentError", message);
    window.location.href = `/checkout?${backParams.toString()}`;
    // sp는 마운트 시점 쿼리만 필요
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="app-shell">
      <Loading />
    </div>
  );
}
