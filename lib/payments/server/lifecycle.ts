/*
  실 PG(토스) 결제 서버 라이프사이클 — 승인(confirm) / 승인 전 취소(cancel) / 전체 환불(refund).
  라우트(app/api/payments/*)는 의존성(Supabase service_role RPC, 토스 호출, 로그)을 주입해 이 함수들을 부른다 — 테스트는 전부 가짜 의존성으로 실행하며 실제 토스/DB를 호출하지 않는다.

  신뢰 경계(브라우저가 보내는 값은 힌트일 뿐):
    · 로그인 사용자: Bearer 토큰을 서버가 검증(getAuthUid). profileId/centerId는 받지 않는다.
    · 주문/수강권: orderId/membershipId 하나로 서버가 DB에서 본인 소유·상태·금액·provider를 읽는다(pg_order_context / pg_refund_context).
    · 금액: 토스에는 항상 DB 주문 금액을 보낸다(요청의 amount는 DB 값과 같은지 비교만).
    · paymentKey: 승인은 토스가 paymentKey+orderId+amount 일치를 검증하고, 응답의 orderId/totalAmount를 서버가 다시 대조한다. 환불은 DB(payments.pg_transaction_id)에 저장된 값만 쓴다.

  돈이 움직이는 시점: 토스 승인(confirm) 성공 순간(카드 승인) / 토스 취소 성공 순간(승인 취소). DB 확정은 그 뒤.
  승인 성공 → DB 확정 실패: 보상 취소(서버만, 1회, Idempotency-Key). DB 상태가 불확실하면(재조회 실패) 자동 취소하지 않고 운영 알림만 남긴다.
  환불: 토스 취소를 "먼저" 하고 성공(또는 이미 취소됨)이 확인된 뒤 DB 환불을 마무리한다 — DB 환불 후 토스 취소가 실패하면 돈이 안 돌아가는 반면,
        토스 취소 후 DB 실패는 같은 요청을 다시 보내면 이어서 처리(이미 취소됨 → DB만 재시도)할 수 있기 때문이다.
*/
import type { TossResult } from "./toss";

export type OrderCtx = { orderId: string; status: string; amount: number; provider: string | null };
export type RefundCtx = {
  membershipId: string; status: string; blockReason: string | null; orderId: string | null;
  provider: string | null; paymentKey: string | null; amount: number;
};
type DbResult<T = any> = { data: T | null; error: { message: string } | null };

export type LifecycleDeps = {
  getAuthUid(token: string): Promise<string | null>;
  orderContext(orderId: string, uid: string): Promise<OrderCtx | null>;
  gateAllows(orderId: string): Promise<boolean>;
  tossConfirm(p: { paymentKey: string; orderId: string; amount: number; idempotencyKey: string }): Promise<TossResult>;
  tossCancel(paymentKey: string, p: { cancelReason: string; idempotencyKey: string }): Promise<TossResult>;
  tossGet(paymentKey: string): Promise<TossResult>;
  dbConfirm(orderId: string, paymentKey: string, amount: number): Promise<DbResult>;
  dbCancelOrder(orderId: string): Promise<DbResult>;
  refundContext(membershipId: string, uid: string): Promise<RefundCtx | null>;
  dbRefund(membershipId: string, uid: string, opts: { allowPg: boolean; force: boolean }): Promise<DbResult>;
  log(level: "info" | "warn" | "error", event: string, fields: Record<string, unknown>): void;
};
export type Reply = { status: number; body: Record<string, unknown> };

const PG_PROVIDERS = ["toss", "portone"];
const stripPrefix = (m: string) => m.replace(/^.*?:\s*/, "");
// 로그에는 paymentKey 전체를 남기지 않는다(뒤 6자리만).
export const maskKey = (k: string) => (k.length > 6 ? `…${k.slice(-6)}` : "…");

export async function handleConfirm(input: { token: string | null; paymentKey?: unknown; orderId?: unknown; amount?: unknown }, d: LifecycleDeps): Promise<Reply> {
  const { paymentKey, orderId, amount } = input;
  if (typeof paymentKey !== "string" || !paymentKey || typeof orderId !== "string" || !orderId || typeof amount !== "number") {
    return { status: 400, body: { error: "paymentKey/orderId/amount가 모두 필요해요" } };
  }
  const uid = input.token ? await d.getAuthUid(input.token) : null;
  if (!uid) return { status: 401, body: { error: "로그인이 필요해요" } };

  const ctx = await d.orderContext(orderId, uid);
  if (!ctx) return { status: 404, body: { error: "주문을 찾을 수 없어요" } };
  if (ctx.provider !== "toss") return { status: 400, body: { error: "토스 결제 주문이 아니에요" } };
  if (ctx.amount !== amount) return { status: 400, body: { error: "결제 금액이 주문 금액과 일치하지 않아요" } };
  if (ctx.status === "done") return { status: 200, body: { ok: true, already_done: true } };
  if (ctx.status !== "pending") return { status: 409, body: { error: ctx.status === "cancelled" ? "취소된 주문은 결제할 수 없어요" : "결제를 진행할 수 없는 주문 상태예요" } };
  if (!(await d.gateAllows(orderId))) return { status: 403, body: { error: "온라인 결제는 아직 사용할 수 없어요" } };

  // 1) 토스 승인(돈이 움직이는 시점). 금액은 DB 주문 금액.
  const idem = `confirm:${orderId}:${paymentKey}`;
  let approved = await d.tossConfirm({ paymentKey, orderId, amount: ctx.amount, idempotencyKey: idem });
  if (!approved.ok) {
    if (approved.code === "ALREADY_PROCESSED_PAYMENT") {
      // 같은 승인 요청이 이미 처리됨(중복/동시 요청) — 새로 승인하거나 취소하지 않고 DB 상태만 본다.
      const again = await d.orderContext(orderId, uid);
      if (again?.status === "done") return { status: 200, body: { ok: true, already_done: true } };
      return { status: 409, body: { error: "이미 처리 중인 결제예요. 잠시 후 구매내역을 확인해주세요" } };
    }
    if (approved.status === 0) {
      // 응답을 못 받음 — 승인됐는지 모른다. 실제 상태를 조회해 DONE이면 승인된 것으로 이어간다.
      const look = await d.tossGet(paymentKey);
      if (look.ok && look.data?.status === "DONE" && look.data?.orderId === orderId) {
        approved = { ok: true, data: look.data };
      } else {
        d.log("error", "PG_CONFIRM_UNKNOWN", { orderId, paymentKey: maskKey(paymentKey), reason: approved.message });
        return { status: 502, body: { error: "결제 승인 결과를 확인하지 못했어요. 결제 내역을 확인한 뒤 다시 시도해주세요", code: "toss_confirm_unknown" } };
      }
    } else {
      return { status: approved.status >= 400 ? approved.status : 400, body: { error: approved.message } };   // 승인 전 실패 — DB/취소 호출 없음
    }
  }
  if (!approved.ok) return { status: 502, body: { error: "결제 승인에 실패했어요" } };   // (타입 가드)

  // 2) 승인 응답이 우리 주문과 맞는지 대조(맞지 않으면 승인된 돈을 되돌려야 한다)
  const tossOrderId = approved.data?.orderId;
  const tossAmount = typeof approved.data?.totalAmount === "number" ? approved.data.totalAmount : ctx.amount;
  if ((tossOrderId !== undefined && tossOrderId !== orderId) || tossAmount !== ctx.amount) {
    return compensate(d, { orderId, paymentKey, cause: "토스 승인 응답이 주문과 일치하지 않아요", uid });
  }

  // 3) DB 확정(수강권/결제/주문 완료)
  const res = await d.dbConfirm(orderId, paymentKey, ctx.amount);
  if (!res.error) return { status: 200, body: { ok: true, ...(res.data ?? {}) } };

  // 4) DB 확정 실패 — 실제로 커밋됐는지(응답 유실) 먼저 확인한다. done이면 보상하지 않는다.
  let after: OrderCtx | null = null;
  try { after = await d.orderContext(orderId, uid); } catch { after = null; }
  if (after?.status === "done") return { status: 200, body: { ok: true, already_done: true } };
  if (!after) {
    d.log("error", "PG_CONFIRM_STATE_UNKNOWN", { orderId, paymentKey: maskKey(paymentKey), dbError: res.error.message });
    return { status: 500, body: { error: "결제는 승인됐지만 확정 상태를 확인하지 못했어요. 운영자에게 문의해주세요", code: "confirm_state_unknown", dbError: res.error.message } };
  }
  return compensate(d, { orderId, paymentKey, cause: res.error.message, uid });
}

// 승인된 결제를 서버에서 취소(1회). 원래 오류를 숨기지 않고 응답/로그에 남긴다.
async function compensate(d: LifecycleDeps, p: { orderId: string; paymentKey: string; cause: string; uid: string }): Promise<Reply> {
  const cancel = await d.tossCancel(p.paymentKey, { cancelReason: "결제 확정 실패로 자동 취소", idempotencyKey: `compensate:${p.orderId}:${p.paymentKey}` });
  if (cancel.ok || cancel.code === "ALREADY_CANCELED_PAYMENT") {
    const o = await d.dbCancelOrder(p.orderId);   // 주문을 cancelled로(포인트 복원은 DB 트리거)
    if (o.error) d.log("error", "PG_COMPENSATION_ORDER_CANCEL_FAILED", { orderId: p.orderId, dbError: o.error.message });
    d.log("warn", "PG_COMPENSATED", { orderId: p.orderId, paymentKey: maskKey(p.paymentKey), dbError: p.cause });
    return { status: 500, body: { error: `${stripPrefix(p.cause)} — 결제는 자동으로 취소했어요. 카드 승인 취소 반영은 카드사에 따라 며칠 걸릴 수 있어요`, code: "payment_compensated", dbError: p.cause } };
  }
  d.log("error", "PG_COMPENSATION_FAILED", { orderId: p.orderId, paymentKey: maskKey(p.paymentKey), dbError: p.cause, cancelError: cancel.message, cancelStatus: cancel.status });
  return {
    status: 500,
    body: {
      error: "결제는 승인됐지만 확정과 자동 취소에 모두 실패했어요. 센터 또는 운영자에게 주문번호를 알려 문의해주세요",
      code: "compensation_failed", orderId: p.orderId, dbError: p.cause, cancelError: cancel.message,
    },
  };
}

// 승인 "전"에 끝난 PG 주문(결제창 닫힘/실패) 취소 — 이미 승인·발급된 주문은 취소하지 않는다. 토스 취소 API는 호출하지 않는다.
export async function handleCancel(input: { token: string | null; orderId?: unknown }, d: LifecycleDeps): Promise<Reply> {
  if (typeof input.orderId !== "string" || !input.orderId) return { status: 400, body: { error: "orderId가 필요해요" } };
  const uid = input.token ? await d.getAuthUid(input.token) : null;
  if (!uid) return { status: 401, body: { error: "로그인이 필요해요" } };
  const ctx = await d.orderContext(input.orderId, uid);
  if (!ctx) return { status: 404, body: { error: "주문을 찾을 수 없어요" } };
  if (!ctx.provider || !PG_PROVIDERS.includes(ctx.provider)) return { status: 400, body: { error: "실제 PG 주문만 취소할 수 있어요" } };
  if (ctx.status === "cancelled") return { status: 200, body: { ok: true, cancelled: true, already: true } };
  if (ctx.status !== "pending") return { status: 409, body: { error: "이미 발급·처리된 주문은 취소할 수 없어요. 환불은 환불 요청을 이용해주세요" } };
  const r = await d.dbCancelOrder(ctx.orderId);
  if (r.error) return { status: 409, body: { error: stripPrefix(r.error.message) } };
  return { status: 200, body: { ok: true, cancelled: true } };
}

// 회원 전체 환불 — 실 PG 주문은 서버에서 토스 취소 → DB 환불, direct/manual/mock은 DB 환불만.
export async function handleRefund(input: { token: string | null; membershipId?: unknown }, d: LifecycleDeps): Promise<Reply> {
  if (typeof input.membershipId !== "string" || !input.membershipId) return { status: 400, body: { error: "membershipId가 필요해요" } };
  const uid = input.token ? await d.getAuthUid(input.token) : null;
  if (!uid) return { status: 401, body: { error: "로그인이 필요해요" } };
  const ctx = await d.refundContext(input.membershipId, uid);
  if (!ctx) return { status: 404, body: { error: "수강권을 찾을 수 없어요" } };
  if (ctx.status === "refunded") return { status: 409, body: { error: "이미 환불된 수강권이에요", code: "already_refunded" } };

  const isPgProvider = !!ctx.provider && PG_PROVIDERS.includes(ctx.provider);
  const needsPgCancel = isPgProvider && ctx.amount > 0;

  if (!needsPgCancel) {
    // direct/manual/mock(또는 0원 PG 주문): 기존 DB 환불 그대로. 0원 PG 주문만 PG 가드를 통과시킨다.
    const r = await d.dbRefund(ctx.membershipId, uid, { allowPg: isPgProvider, force: false });
    if (r.error) return { status: 400, body: { error: stripPrefix(r.error.message) } };
    return { status: 200, body: { ok: true, ...(r.data ?? {}) } };
  }
  if (!ctx.paymentKey) {
    d.log("error", "PG_REFUND_NO_PAYMENT_KEY", { membershipId: ctx.membershipId, orderId: ctx.orderId });
    return { status: 409, body: { error: "카드 결제 정보를 확인할 수 없어요. 센터에 문의해주세요", code: "no_payment_key" } };
  }

  let force = false;
  if (ctx.blockReason) {
    // 환불 불가 사유가 있어도, 이전 요청에서 토스 취소만 끝나고 DB가 실패한 경우라면 이어서 마무리한다(토스가 이미 CANCELED일 때만).
    const look = await d.tossGet(ctx.paymentKey);
    if (!(look.ok && look.data?.status === "CANCELED")) return { status: 409, body: { error: ctx.blockReason } };
    force = true;
  } else {
    const cancel = await d.tossCancel(ctx.paymentKey, { cancelReason: "회원 환불 요청", idempotencyKey: `refund:${ctx.membershipId}` });
    if (!cancel.ok && cancel.code !== "ALREADY_CANCELED_PAYMENT") {
      d.log("warn", "PG_REFUND_CANCEL_FAILED", { membershipId: ctx.membershipId, orderId: ctx.orderId, paymentKey: maskKey(ctx.paymentKey), cancelError: cancel.message, cancelStatus: cancel.status });
      return { status: 502, body: { error: "카드 결제를 취소하지 못했어요. 잠시 후 다시 시도해주세요(환불은 진행되지 않았어요)", code: "pg_cancel_failed" } };
    }
    force = true;   // 토스 취소 확정 — DB 환불은 조건 재검사 때문에 실패하지 않게 마무리한다
  }

  let r = await d.dbRefund(ctx.membershipId, uid, { allowPg: true, force });
  if (r.error && !/이미 환불/.test(r.error.message)) r = await d.dbRefund(ctx.membershipId, uid, { allowPg: true, force });   // 1회 재시도
  if (r.error) {
    if (/이미 환불/.test(r.error.message)) return { status: 200, body: { ok: true, refunded: true, already: true } };
    d.log("error", "PG_REFUND_DB_FAILED_AFTER_PG_CANCEL", { membershipId: ctx.membershipId, orderId: ctx.orderId, paymentKey: maskKey(ctx.paymentKey), dbError: r.error.message });
    return { status: 500, body: { error: "카드 결제는 취소됐지만 환불 처리를 마치지 못했어요. 같은 요청을 다시 하면 이어서 처리돼요", code: "refund_db_failed_after_pg_cancel", dbError: r.error.message } };
  }
  return { status: 200, body: { ok: true, ...(r.data ?? {}) } };
}
