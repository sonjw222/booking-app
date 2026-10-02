"use client";

/*
  토스 failUrl(승인 전 실패/취소) — 외부 Safari에는 앱의 로그인 세션이 없으므로 Supabase 세션 대신 복귀 토큰으로
  서버 복귀 전용 라우트(/api/payments/return/cancel)에 pending 주문 취소를 요청한다(포인트 복원은 DB 트리거). 발급·처리된 주문은 서버가 거부한다.
  /checkout으로 redirect하지 않고 결과를 직접 보여준다. 처리 직후 주소창의 returnToken을 제거한다.
*/
import { Suspense, useEffect, useState } from "react";
// Loading은 사용하지 않는다(즉시 결과 화면)
import { useSearchParams } from "next/navigation";
import { returnCancel, scrubCallbackUrl } from "../../../lib/payments/returnApi";
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
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const orderId = sp.get("orderId");
    const returnToken = sp.get("returnToken");
    setMessage(sp.get("message"));
    scrubCallbackUrl();
    if (orderId && returnToken) void returnCancel({ returnToken, orderId });   // 실패해도 결과 화면은 그대로(주문 정리는 최선)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="app-shell">
      <div className="daylist-empty" style={{ paddingTop: 80 }}>
        <b>결제가 취소됐어요.</b><br />
        {message ? <>{message}<br /></> : null}
        모하빗 앱으로 돌아가 다시 시도해주세요.
      </div>
    </div>
  );
}
