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
  provider: string | null; paymentKey: string | null; amount: number; refundPending?: boolean;
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
  // 환불 진행 표시(DB의 memberships.pg_refund_started_at): 토스 취소를 호출하는 동안 새 예약/횟수 차감을 DB가 거부하게 한다.
  refundBegin(membershipId: string, uid: string): Promise<{ state: "locked" | "resumed" | "blocked" | "refunded"; reason?: string }>;
  refundRelease(membershipId: string, uid: string): Promise<DbResult>;
  // skipTimeCheck: 24시간 조건만 건너뜀(토스 취소가 이미 확정된 뒤 마무리용). "이미 사용함" 조건은 어떤 경우에도 건너뛰지 않는다.
  dbRefund(membershipId: string, uid: string, opts: { allowPg: boolean; skipTimeCheck: boolean }): Promise<DbResult>;
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
    if (approved.code === "ALREADY_PROCESSED_PAYMENT" || approved.code === "ALREADY_CANCELED_PAYMENT") {
      // 이미 토스에서 처리된 결제 — 새로 승인/취소하지 않고, 실제 토스 상태를 조회해 DB를 그 상태로 수렴시킨다.
      return recoverProcessedPayment(d, { orderId, paymentKey, uid, ctx });
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

  // 3) DB 확정
  return confirmInDb(d, { orderId, paymentKey, uid, amount: ctx.amount });
}

// DB 확정(수강권/결제/주문 완료). 실패하면 실제로 커밋됐는지 재확인한 뒤에만 보상 취소한다.
async function confirmInDb(d: LifecycleDeps, p: { orderId: string; paymentKey: string; uid: string; amount: number }): Promise<Reply> {
  const res = await d.dbConfirm(p.orderId, p.paymentKey, p.amount);
  if (!res.error) return { status: 200, body: { ok: true, ...(res.data ?? {}) } };

  // DB 확정 실패 — 실제로는 커밋됐는지(응답 유실) 먼저 확인한다. done이면 보상하지 않는다.
  let after: OrderCtx | null = null;
  try { after = await d.orderContext(p.orderId, p.uid); } catch { after = null; }
  if (after?.status === "done") return { status: 200, body: { ok: true, already_done: true } };
  if (!after) {
    d.log("error", "PG_CONFIRM_STATE_UNKNOWN", { orderId: p.orderId, paymentKey: maskKey(p.paymentKey), dbError: res.error.message });
    return { status: 500, body: { error: "결제는 승인됐지만 확정 상태를 확인하지 못했어요. 운영자에게 문의해주세요", code: "confirm_state_unknown", dbError: res.error.message } };
  }
  return compensate(d, { orderId: p.orderId, paymentKey: p.paymentKey, cause: res.error.message, uid: p.uid });
}

// 토스가 "이미 처리된 결제"라고 답한 경우(중복 요청/이전 요청의 DB 확정 실패/보상 후 DB 정리 실패) — 토스 실제 상태 기준으로 DB를 수렴시킨다.
async function recoverProcessedPayment(d: LifecycleDeps, p: { orderId: string; paymentKey: string; uid: string; ctx: OrderCtx }): Promise<Reply> {
  const unknown = (reason: string): Reply => {
    d.log("error", "PG_CONFIRM_STATE_UNKNOWN", { orderId: p.orderId, paymentKey: maskKey(p.paymentKey), reason });
    return { status: 409, body: { error: "결제 상태를 확인하지 못했어요. 잠시 후 구매내역을 확인하거나 센터에 문의해주세요", code: "state_unknown" } };
  };
  let again: OrderCtx | null = null;
  try { again = await d.orderContext(p.orderId, p.uid); } catch { again = null; }
  if (!again) return unknown("order context unavailable");
  if (again.status === "done") return { status: 200, body: { ok: true, already_done: true } };

  const look = await d.tossGet(p.paymentKey);
  if (!look.ok) return unknown(`toss lookup failed: ${look.message}`);
  const t = look.data ?? {};

  if (t.status === "DONE") {
    // 토스 승인은 끝났는데 DB가 확정되지 않은 상태 — 토스 응답이 이 주문/금액과 일치할 때만 DB 확정을 이어서 한다.
    if (t.orderId !== p.orderId || t.totalAmount !== again.amount) {
      d.log("error", "PG_RECOVER_MISMATCH", { orderId: p.orderId, paymentKey: maskKey(p.paymentKey), tossOrderMatches: t.orderId === p.orderId, tossAmountMatches: t.totalAmount === again.amount });
      return { status: 409, body: { error: "결제 정보가 주문과 일치하지 않아 확정할 수 없어요. 센터에 문의해주세요", code: "payment_mismatch" } };
    }
    if (again.status !== "pending") {
      // 이미 취소된 주문인데 토스는 승인 상태 — 돈만 승인된 상태이므로 승인을 취소한다.
      return compensate(d, { orderId: p.orderId, paymentKey: p.paymentKey, cause: "취소된 주문의 결제가 승인되어 있어요", uid: p.uid });
    }
    return confirmInDb(d, { orderId: p.orderId, paymentKey: p.paymentKey, uid: p.uid, amount: again.amount });
  }
  if (t.status === "CANCELED") {
    // 토스는 이미 취소 — DB 주문도 cancelled로 수렴(포인트 복원은 DB 트리거). 이미 cancelled면 멱등.
    if (again.status === "cancelled") return { status: 409, body: { error: "취소된 결제예요", code: "payment_canceled", already: true } };
    const cleaned = await cleanupOrder(d, p.orderId);
    if (!cleaned.ok) {
      d.log("error", "PG_COMPENSATION_DB_CLEANUP_FAILED", { orderId: p.orderId, paymentKey: maskKey(p.paymentKey), dbError: cleaned.error });
      return cleanupFailedReply(p.orderId, cleaned.error);
    }
    return { status: 409, body: { error: "취소된 결제예요", code: "payment_canceled" } };
  }
  return unknown(`toss status ${String(t.status)}`);   // 승인 미완료/만료 등 — 새 승인·취소를 임의로 하지 않는다
}

// 주문을 cancelled로(포인트 복원은 트리거). 일시 실패를 고려해 최대 1회만 재시도.
async function cleanupOrder(d: LifecycleDeps, orderId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  let last = "";
  for (let i = 0; i < 2; i++) {
    const r = await d.dbCancelOrder(orderId);
    if (!r.error) return { ok: true };
    last = r.error.message;
  }
  return { ok: false, error: last };
}
function cleanupFailedReply(orderId: string, dbError: string): Reply {
  return {
    status: 500,
    body: {
      error: "카드 결제 승인은 취소됐지만 앱 주문/포인트 정리를 마치지 못했어요. 주문번호를 알려 센터 또는 운영자에게 문의해주세요(같은 결제를 다시 시도해도 이어서 정리돼요)",
      code: "payment_compensated_db_cleanup_failed", orderId, dbError,
    },
  };
}

// 승인된 결제를 서버에서 취소(1회). 원래 오류를 숨기지 않고 응답/로그에 남긴다.
async function compensate(d: LifecycleDeps, p: { orderId: string; paymentKey: string; cause: string; uid: string }): Promise<Reply> {
  const cancel = await d.tossCancel(p.paymentKey, { cancelReason: "결제 확정 실패로 자동 취소", idempotencyKey: `compensate:${p.orderId}:${p.paymentKey}` });
  if (cancel.ok || cancel.code === "ALREADY_CANCELED_PAYMENT") {
    const cleaned = await cleanupOrder(d, p.orderId);
    if (!cleaned.ok) {
      d.log("error", "PG_COMPENSATION_DB_CLEANUP_FAILED", { orderId: p.orderId, paymentKey: maskKey(p.paymentKey), dbError: cleaned.error, originalError: p.cause });
      return cleanupFailedReply(p.orderId, cleaned.error);
    }
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
    const r = await d.dbRefund(ctx.membershipId, uid, { allowPg: isPgProvider, skipTimeCheck: false });
    if (r.error) return { status: 400, body: { error: stripPrefix(r.error.message) } };
    return { status: 200, body: { ok: true, ...(r.data ?? {}) } };
  }
  if (!ctx.paymentKey) {
    d.log("error", "PG_REFUND_NO_PAYMENT_KEY", { membershipId: ctx.membershipId, orderId: ctx.orderId });
    return { status: 409, body: { error: "카드 결제 정보를 확인할 수 없어요. 센터에 문의해주세요", code: "no_payment_key" } };
  }
  const paymentKey = ctx.paymentKey;

  // 1) 환불 진행 표시 — DB가 행 잠금 아래에서 환불 가능 조건(24시간/미사용)을 확인하고 표시를 건다.
  //    표시가 걸린 동안 이 수강권의 새 예약/횟수 차감은 DB 트리거가 거부한다(조건 확인 → 토스 취소 사이의 사용을 차단).
  let begin: Awaited<ReturnType<LifecycleDeps["refundBegin"]>>;
  try { begin = await d.refundBegin(ctx.membershipId, uid); } catch (e) {
    return { status: 400, body: { error: stripPrefix(e instanceof Error ? e.message : "환불을 시작하지 못했어요") } };
  }
  if (begin.state === "refunded") return { status: 409, body: { error: "이미 환불된 수강권이에요", code: "already_refunded" } };

  let skipTimeCheck = false;
  if (begin.state === "blocked") {
    // 환불 불가 사유(24시간 경과 등). 단, 이전 요청에서 토스 취소는 끝났는데 DB 환불이 실패한 건이라면(토스가 이미 CANCELED) 이어서 마무리한다.
    const look = await d.tossGet(paymentKey);
    if (!(look.ok && look.data?.status === "CANCELED")) return { status: 409, body: { error: begin.reason ?? "환불할 수 없는 수강권이에요" } };
    skipTimeCheck = true;   // 시간 조건만 건너뜀 — 사용 여부는 DB가 항상 다시 확인한다
  } else {
    // locked(새로 표시) 또는 resumed(이전 시도의 표시가 남아있음, 시간 조건은 표시 당시 이미 통과)
    skipTimeCheck = true;
    const cancel = await d.tossCancel(paymentKey, { cancelReason: "회원 환불 요청", idempotencyKey: `refund:${ctx.membershipId}` });
    if (!cancel.ok && cancel.code !== "ALREADY_CANCELED_PAYMENT") {
      d.log("warn", "PG_REFUND_CANCEL_FAILED", { membershipId: ctx.membershipId, orderId: ctx.orderId, paymentKey: maskKey(paymentKey), cancelError: cancel.message, cancelStatus: cancel.status, state: begin.state });
      // 결과가 불확실한 실패(네트워크/5xx)는 실제 토스 상태를 확인한다 — 이미 취소됐다면 표시를 풀면 안 된다.
      const ambiguous = cancel.status === 0 || cancel.status >= 500;
      let canceledAnyway = false;
      if (ambiguous) {
        const look = await d.tossGet(paymentKey);
        if (look.ok && look.data?.status === "CANCELED") canceledAnyway = true;
        else if (!look.ok) {
          d.log("error", "PG_REFUND_STATE_UNKNOWN", { membershipId: ctx.membershipId, paymentKey: maskKey(paymentKey) });
          return { status: 502, body: { error: "카드 결제 취소 결과를 확인하지 못했어요. 같은 요청을 다시 시도하면 이어서 확인해요", code: "pg_cancel_unknown" } };
        }
      }
      if (!canceledAnyway) {
        // 토스가 취소하지 않았음이 확실 — 수강권을 원래 이용 가능 상태로 되돌린다(이전 시도에서 이어온 경우도 동일).
        const rel = await d.refundRelease(ctx.membershipId, uid);
        if (rel.error) d.log("error", "PG_REFUND_RELEASE_FAILED", { membershipId: ctx.membershipId, dbError: rel.error.message });
        return { status: 502, body: { error: "카드 결제를 취소하지 못했어요. 잠시 후 다시 시도해주세요(환불은 진행되지 않았어요)", code: "pg_cancel_failed" } };
      }
    }
  }

  // 2) DB 환불 마무리(쿠폰/포인트 복원 포함). 실패해도 표시는 남아 있어 다음 요청이 이어서 완료한다.
  let r = await d.dbRefund(ctx.membershipId, uid, { allowPg: true, skipTimeCheck });
  if (r.error && !/이미 환불/.test(r.error.message)) r = await d.dbRefund(ctx.membershipId, uid, { allowPg: true, skipTimeCheck });   // 1회 재시도
  if (r.error) {
    if (/이미 환불/.test(r.error.message)) return { status: 200, body: { ok: true, refunded: true, already: true } };
    d.log("error", "PG_REFUND_DB_FAILED_AFTER_PG_CANCEL", { membershipId: ctx.membershipId, orderId: ctx.orderId, paymentKey: maskKey(paymentKey), dbError: r.error.message });
    return { status: 500, body: { error: "카드 결제는 취소됐지만 환불 처리를 마치지 못했어요. 같은 요청을 다시 하면 이어서 처리돼요", code: "refund_db_failed_after_pg_cancel", dbError: r.error.message } };
  }
  return { status: 200, body: { ok: true, ...(r.data ?? {}) } };
}
