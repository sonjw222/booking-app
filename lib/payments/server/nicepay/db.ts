/*
  NICEPAY 라이프사이클의 DB 의존성 어댑터 — add_nicepay_provider_support_20261016.sql(검토용 초안, 미적용)의 service_role RPC 이름/인자와 1:1.
  ⚠ 어디에도 연결되지 않았다. admin은 service_role Supabase 클라이언트의 rpc만 쓰는 최소 인터페이스(테스트는 가짜 rpc).
  NicepayDeps 중 DB와 무관한 것(creds, fetchImpl, now, gateAllows, log)은 호출자가 조립한다.
*/
import type { NicepayDeps } from "./lifecycle";

export type RpcLike = { rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }> };
type DbPart = Pick<NicepayDeps, "orderContext" | "claimOrder" | "releaseOrder" | "markReview" | "dbConfirm">;

export function nicepayDbDeps(admin: RpcLike): DbPart {
  return {
    async orderContext(orderId) {
      const { data, error } = await admin.rpc("nicepay_order_context", { p_order_id: orderId });
      if (error) throw new Error(error.message);
      return (data as { orderId: string; status: string; amount: number; provider: string | null } | null) ?? null;
    },
    async claimOrder(orderId) {
      const { data, error } = await admin.rpc("nicepay_claim_order", { p_order_id: orderId });
      if (error) throw new Error(error.message);
      return typeof data === "string" && data ? data : null;
    },
    async releaseOrder(orderId, claimId, basis) {
      const { error } = await admin.rpc("nicepay_release_order", { p_order_id: orderId, p_claim_id: claimId, p_basis: basis });
      if (error) throw new Error(error.message);
    },
    async markReview(orderId, claimId, reason) {
      const { error } = await admin.rpc("nicepay_mark_review", { p_order_id: orderId, p_claim_id: claimId, p_reason: reason });
      if (error) throw new Error(error.message);
    },
    async dbConfirm(orderId, claimId, tid, amount) {
      const { data, error } = await admin.rpc("confirm_nicepay_payment", { p_order_id: orderId, p_claim_id: claimId, p_tid: tid, p_amount: amount });
      return { data: (data as Record<string, unknown> | null) ?? null, error: error ? { message: error.message } : null };
    },
  };
}
