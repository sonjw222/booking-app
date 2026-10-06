"use client";

/*
  토스 failUrl(승인 전 실패/취소) — 외부 Safari에는 앱의 로그인 세션이 없으므로 Supabase 세션 대신 복귀 토큰으로
  서버 복귀 전용 라우트(/api/payments/return/cancel)에 pending 주문 취소를 요청한다(포인트 복원은 DB 트리거).
  서버가 취소를 확인(ok)했을 때만 "취소됐어요"를 보여주고, 실패/무효/네트워크 오류는 취소 완료로 단정하지 않는다.
  쿼리 값은 먼저 메모리로 읽은 뒤 주소창에서 제거(scrub)한다. 재시도는 일시 오류에 한해 최대 1회.
*/
import { Suspense, useEffect, useState } from "react";
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
  const [state, setState] = useState<{ kind: "working" } | { kind: "done"; message: string | null } | { kind: "error" }>({ kind: "working" });

  useEffect(() => {
    const orderId = sp.get("orderId");
    const returnToken = sp.get("returnToken");
    const message = sp.get("message");
    scrubCallbackUrl();
    if (!orderId || !returnToken) { setState({ kind: "error" }); return; }
    (async () => {
      let r = await returnCancel({ returnToken, orderId });
      if (!r.ok && (r.status === 0 || r.status >= 500)) r = await returnCancel({ returnToken, orderId });   // 일시 오류만 1회 재시도
      setState(r.ok ? { kind: "done", message } : { kind: "error" });
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="app-shell">
      {state.kind === "working" && <Loading />}
      {state.kind === "done" && (
        <div className="daylist-empty daylist-empty--page">
          <b>결제가 취소됐어요.</b><br />
          {state.message ? <>{state.message}<br /></> : null}
          모하빗 앱으로 돌아가 다시 시도해주세요.
        </div>
      )}
      {state.kind === "error" && (
        <div className="daylist-empty daylist-empty--page" role="alert">
          <b>결제 취소 상태를 확인하지 못했어요.</b><br />
          모하빗 앱으로 돌아가 구매내역을 확인해주세요.
        </div>
      )}
    </div>
  );
}
