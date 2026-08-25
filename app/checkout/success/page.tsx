"use client";

/*
  토스 결제창(TossPaymentProvider.createPayment의 requestPayment)이 승인 성공 시
  돌아오는 successUrl. app/checkout/page.tsx가 만든 successUrl에는 원래 조회 중이던
  쿼리(센터/상품/예약 복귀 정보)가 이미 들어있고, 토스가 그 위에 paymentKey/orderId/amount를
  덧붙여서 리다이렉트한다.

  여기서 서버 승인(app/api/payments/confirm)까지 마친 뒤, 원래 쿼리를 유지한 채
  /checkout으로 되돌려보내 기존 "결제 완료" 화면을 그대로 재사용한다(화면 중복 없음).
*/

import { Suspense, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { getPaymentService } from "../../../lib/payments";
import Loading from "../../components/Loading";

export default function CheckoutSuccessPage() {
  return (
    <Suspense fallback={<Loading />}>
      <CheckoutSuccessContent />
    </Suspense>
  );
}

function CheckoutSuccessContent() {
  const sp = useSearchParams();

  useEffect(() => {
    const paymentKey = sp.get("paymentKey");
    const orderId = sp.get("orderId");
    const amount = sp.get("amount");

    const backParams = new URLSearchParams(sp.toString());
    backParams.delete("paymentKey");
    backParams.delete("orderId");
    backParams.delete("amount");

    if (!paymentKey || !orderId || !amount) {
      backParams.set("paymentError", "결제 정보가 올바르지 않아요");
      window.location.href = `/checkout?${backParams.toString()}`;
      return;
    }

    (async () => {
      try {
        const result = await getPaymentService().confirmPayment(paymentKey, orderId, Number(amount));
        if (result.status === "paid") {
          backParams.set("paymentDone", "1");
          if (result.membershipId) backParams.set("membershipId", result.membershipId);
        } else {
          backParams.set("paymentError", result.message ?? "결제 확정에 실패했어요");
        }
      } catch (e: any) {
        backParams.set("paymentError", e.message ?? "결제 확정에 실패했어요");
      } finally {
        window.location.href = `/checkout?${backParams.toString()}`;
      }
    })();
    // sp는 마운트 시점 쿼리만 필요 — 재실행 불필요(중복 confirm 방지)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="app-shell">
      <Loading />
    </div>
  );
}
