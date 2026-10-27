/*
  NICEPAY 불명확 거래 조사(복구 권고) — 읽기 전용. 이 모듈은 DB·PG 상태를 "바꾸지 않는다": 주문번호로 PG 상태를 조회해 운영자에게 "무엇을 하면 되는지"를 권고만 한다.
  원칙: 불명확한 거래를 자동으로 성공/실패 처리하지 않는다. 확정은 운영자가 서버 RPC(nicepay_confirm_reviewed / nicepay_resolve_review — 2인 승인·증빙 기록)로만 한다.
  대상: approving 상태로 오래 남은 선점(브라우저 종료, 응답 유실, 서버 장애), review 표시된 주문(netcancel_failed / confirm_state_unknown / stale_claim).
*/
import { REST_OK, restLookupByOrderId, verifyRestResponse, parseRestAmount, type RestCreds, type RestFetch } from "./rest";

export type ReconcileAction =
  | "confirm_candidate"      // PG 승인(paid)이 서명 검증으로 확인되고 금액이 주문과 같다 → 운영자가 승인 증빙으로 확정(nicepay_confirm_reviewed) 검토
  | "cancel_candidate"       // PG에 돈이 승인됐는데 금액이 주문과 다르다 → 운영자가 PG 취소 후 취소 기록
  | "release_candidate"      // PG에 승인된 결제가 없음(미승인/실패/만료/이미 취소) → 선점 해소 검토
  | "operator_required";     // 조회 실패·서명 불일치·해석 불가 — 사람이 PG 콘솔에서 확인
export type Reconcile = { action: ReconcileAction; reason: string; tid?: string; pgStatus?: string; amount?: number };

export async function investigateByOrderId(f: RestFetch, c: RestCreds, p: { orderId: string; orderAmount: number; orderDate: string; now: Date }): Promise<Reconcile> {
  const r = await restLookupByOrderId(f, c, { orderId: p.orderId, orderDate: p.orderDate, now: p.now });
  if (!r.ok) return { action: "operator_required", reason: r.status === 0 ? "pg_unreachable" : `pg_http_${r.status}` };
  const d = r.data;
  if (d.resultCode !== REST_OK) {
    // 문서에 "거래 없음" 코드가 명시되지 않았다 → 코드만으로 "승인 없음"을 단정하지 않는다.
    return { action: "operator_required", reason: `pg_result_${String(d.resultCode ?? "none")}` };
  }
  const tid = typeof d.tid === "string" ? d.tid : "";
  if (!tid || !verifyRestResponse(d, c, { tid, orderId: p.orderId })) return { action: "operator_required", reason: "response_untrusted" };
  const amount = parseRestAmount(d.amount) ?? undefined;
  const status = String(d.status ?? "");
  if (status === "paid") return amount === p.orderAmount ? { action: "confirm_candidate", reason: "paid_amount_matches", tid, pgStatus: status, amount } : { action: "cancel_candidate", reason: "paid_amount_differs", tid, pgStatus: status, amount };
  if (status === "cancelled") return { action: "release_candidate", reason: "already_cancelled", tid, pgStatus: status, amount };
  if (status === "failed" || status === "expired" || status === "ready") return { action: "release_candidate", reason: `pg_${status}`, tid, pgStatus: status, amount };
  return { action: "operator_required", reason: `pg_status_${status || "none"}`, tid, pgStatus: status };   // partialCancelled 등
}
