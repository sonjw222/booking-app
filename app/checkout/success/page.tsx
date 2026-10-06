"use client";

/*
  토스 successUrl — 외부 Safari에서 열릴 수 있어 앱(WebView)의 Supabase 로그인 세션이 없다. 그래서 세션에 의존하지 않고,
  결제 시작 때 서버가 발급한 주문 전용 복귀 토큰(returnToken)으로 서버 복귀 전용 라우트(/api/payments/return/confirm)에 승인을 요청한다.
  /checkout으로 다시 redirect하지 않고(세션이 없어 같은 문제가 반복) 결과를 이 페이지에 직접 보여준다. 앱으로 돌아가면 상태가 자동 반영된다.
  처리 직후 주소창의 민감한 쿼리(returnToken/paymentKey)를 제거한다.
*/
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { returnConfirmWithRetry, scrubCallbackUrl } from "../../../lib/payments/returnApi";
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
  const [state, setState] = useState<{ kind: "working" } | { kind: "done" } | { kind: "error"; message: string }>({ kind: "working" });

  useEffect(() => {
    const paymentKey = sp.get("paymentKey");
    const orderId = sp.get("orderId");
    const amount = Number(sp.get("amount"));
    const returnToken = sp.get("returnToken");
    scrubCallbackUrl();
    if (!paymentKey || !orderId || !returnToken || !Number.isFinite(amount)) {
      setState({ kind: "error", message: "결제 정보가 올바르지 않아요. 모하빗 앱에서 구매내역을 확인해주세요." });
      return;
    }
    (async () => {
      const r = await returnConfirmWithRetry({ returnToken, paymentKey, orderId, amount });
      setState(r.ok ? { kind: "done" } : { kind: "error", message: (r.status === 0 || r.status >= 500 ? "결제 결과를 확인하지 못했어요. 모하빗 앱의 구매내역을 확인해주세요." : r.error ?? "결제 결과를 확인하지 못했어요. 모하빗 앱의 구매내역을 확인해주세요.") });
    })();
    // 마운트 시점 쿼리만 필요 — 재실행하면 중복 confirm이 된다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="app-shell">
      {state.kind === "working" && <Loading />}
      {state.kind === "done" && (
        <div className="daylist-empty daylist-empty--page">
          <b>결제가 완료됐어요.</b><br />
          모하빗 앱으로 돌아가면 구매내역이 자동으로 반영돼요.
        </div>
      )}
      {state.kind === "error" && (
        <div className="daylist-empty daylist-empty--page" role="alert">
          <b>결제 결과를 확인하지 못했어요.</b><br />
          {state.message}
        </div>
      )}
    </div>
  );
}
