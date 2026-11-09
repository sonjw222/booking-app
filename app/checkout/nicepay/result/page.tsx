"use client";

/*
  NICEPAY 결제 결과 화면 — 결제창 → returnUrl(서버 승인) → 303 으로 도착하는 곳.
  ★ 이 화면에 도착했다는 사실은 결제 성공이 아니다. 서버(DB 주문 상태)가 done이라고 말할 때만 "완료"를 보여준다.
  외부 브라우저(앱 밖)에서 열릴 수 있어 로그인 세션 대신 주문 전용 복귀 토큰(rt)으로 상태를 묻고, 처리 직후 주소창의 토큰을 지운다.
  앱(WebView) 복귀(app=1): 네이티브가 복귀 URL(주문 UUID 뿐, 토큰 없음)을 검증한 뒤 이 화면을 연다 — rt 가 없으므로 앱의 로그인 세션(Bearer)으로 서버에 상태를 묻는다. cancel=1(ISP 취소)이면 먼저 주문 정리를 요청한다
  (서버가 로그인 사용자의 본인 pending 주문만 취소). 복귀했다는 사실만으로 "완료"를 보이지 않는다 — 언제나 서버(DB 주문 상태)가 done 이라고 할 때만.
*/
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { abandonNicepayOrder, pollNicepayStatus, type StatusResult } from "../../../../lib/payments/nicepayClientApi";
import { supabase } from "../../../../lib/supabaseClient";
import { scrubCallbackUrl } from "../../../../lib/payments/returnApi";
import Loading from "../../../components/Loading";

type View = { kind: "working" } | { kind: "done" } | { kind: "review" } | { kind: "failed"; message: string };

export default function NicepayResultPage() {
  return <Suspense fallback={<Loading />}><Content /></Suspense>;
}

function toView(r: StatusResult, authFailed: boolean): View {
  if (!r.ok) return { kind: "failed", message: r.status === 0 || r.status >= 500 ? "결제 결과를 확인하지 못했어요. 모하빗 앱의 구매내역을 확인해주세요." : (r.error ?? "결제 결과를 확인하지 못했어요.") };
  if (r.state === "done") return { kind: "done" };
  if (r.state === "review") return { kind: "review" };
  if (r.state === "processing") return { kind: "failed", message: "결제 확인이 아직 끝나지 않았어요. 잠시 후 모하빗 앱의 구매내역을 확인해주세요." };
  return { kind: "failed", message: authFailed ? "결제가 완료되지 않았어요. 다시 시도해주세요." : "결제가 완료되지 않았어요. 카드 승인이 되지 않았다면 청구되지 않아요." };
}

function Content() {
  const sp = useSearchParams();
  const [view, setView] = useState<View>({ kind: "working" });
  // 첫 렌더의 쿼리로 한 번만 판정한다. scrubCallbackUrl() 이 주소창의 토큰을 지우면 searchParams 가 바뀌는데, 그때 다시 파생하면 정상 결과 옆에 "확인 정보가 올바르지 않거나 만료됐어요" 가 잘못 뜬다(통합 QA 에서 발견).
  // QA 인증만 모드(서버가 승인하지 않고 멈춤): 결제는 완료되지 않았고 청구도 없다 — 항상 이 안내만 보이고 "완료"는 어떤 경우에도 보이지 않는다.
  const [qaAuthOnly] = useState(() => sp.get("qa") === "auth_only");
  const [invalid] = useState(() => sp.get("invalid") === "1" || !sp.get("orderId") || (!sp.get("rt") && sp.get("app") !== "1"));
  useEffect(() => {
    const orderId = sp.get("orderId"), rt = sp.get("rt"), authFailed = sp.get("failed") === "1";
    const appReturn = sp.get("app") === "1" && !rt, appCancel = appReturn && sp.get("cancel") === "1";
    scrubCallbackUrl();
    if (!orderId || (!rt && !appReturn) || sp.get("invalid") === "1") return;
    let alive = true;
    (async () => {
      let bearer: string | null = null;
      if (appReturn) {
        bearer = (await supabase.auth.getSession()).data.session?.access_token ?? null;
        if (!bearer) { if (alive) setView({ kind: "failed", message: "로그인이 필요해요. 로그인 후 모하빗 앱의 구매내역에서 결제 결과를 확인해주세요." }); return; }
        if (appCancel) await abandonNicepayOrder({ orderId, bearer });   // ISP 인증 취소: 아직 승인 전인 본인 주문만 서버가 취소한다
      }
      const r = authFailed || appCancel ? await pollNicepayStatus({ orderId, returnToken: rt, bearer }, { attempts: 1 }) : await pollNicepayStatus({ orderId, returnToken: rt, bearer });
      if (alive) setView(toView(r, authFailed));
    })();
    return () => { alive = false; };
    // 마운트 시점 쿼리만 필요(재실행 방지)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="app-shell">
      {qaAuthOnly && <div className="daylist-empty" style={{ paddingTop: 80 }} role="status" data-testid="qa-auth-only-notice"><b>QA 테스트: 승인하지 않았어요.</b><br />결제창 인증 결과만 확인했고 카드 승인은 요청하지 않았어요. 결제는 완료되지 않았고 청구되지 않아요.</div>}
      {!qaAuthOnly && !invalid && view.kind === "working" && <Loading />}
      {!qaAuthOnly && view.kind === "done" && <div className="daylist-empty" style={{ paddingTop: 80 }}><b>결제가 완료됐어요.</b><br />모하빗 앱으로 돌아가면 구매내역이 자동으로 반영돼요.</div>}
      {!qaAuthOnly && view.kind === "review" && <div className="daylist-empty" style={{ paddingTop: 80 }} role="alert"><b>결제 확인이 필요해요.</b><br />카드 승인 결과를 운영자가 확인하고 있어요. 다시 결제하지 말고 센터 또는 운영자에게 문의해주세요.</div>}
      {!qaAuthOnly && view.kind === "failed" && <div className="daylist-empty" style={{ paddingTop: 80 }} role="alert"><b>결제가 완료되지 않았어요.</b><br />{view.message}</div>}
      {!qaAuthOnly && invalid && <div className="daylist-empty" style={{ paddingTop: 80 }} role="alert"><b>결제 확인 정보가 올바르지 않거나 만료됐어요.</b><br />모하빗 앱에서 구매내역을 확인해주세요.</div>}
    </div>
  );
}
