/*
  NICEPAY 회원 환불 라이프사이클 — Toss 환불(lifecycle.ts handleRefund)과 같은 순서:
    환불 진행 표시(pg_refund_begin) → PG 취소(서명 검증된 응답으로 "취소 확인") → 취소 기록(nicepay_record_pg_cancel) → DB 환불(refund_membership_server).
  ★ DB는 취소 기록(원거래 금액과 같은 cancel_amount)이 없으면 NICEPAY 수강권을 내부 환불하지 않는다(add_nicepay_provider_support [6-4] v2). 이 모듈은 그 기록을 "서버가 검증한 취소 응답"으로만 만든다.
  결과를 알 수 없으면(unknown) 환불 표시를 풀지 않고 502로 멈춘다 — 같은 요청을 다시 보내면 이어서(취소 재요청 → 이미 취소됨이면 조회로 확인) 처리한다. 임의로 성공/실패를 확정하지 않는다.
  금액: 취소 금액 = pg_refund_context의 PG 원거래 금액(fix_refund_amount_integrity)이며 전액 취소만 한다(부분취소 미구현).
  PG 호출은 포트(NicepayRefundPort)로 주입 — REST(v1)·v3 두 계열 각각의 포트를 아래에서 만든다. 테스트는 가짜 포트/가짜 fetch.
*/
import type { RefundCtx } from "../lifecycle";
import { maskKey } from "../lifecycle";
import { cancelAndConfirm, type RestDeps } from "./restLifecycle";
import { REST_OK, restLookup, verifyRestResponse, parseRestAmount, type RestCreds, type RestFetch } from "./rest";
import { nicepayCancel, type NicepayCreds, type NicepayFetch } from "./api";
import { nicepaySign, signatureMatches, parseAmt } from "./signature";
import { responseDigest } from "./digest";

export type CancelOutcome =
  | { kind: "cancelled"; cancelTid: string; digest: string }
  | { kind: "rejected"; code: string | null }   // PG가 취소하지 않았음이 확실(거래가 여전히 승인 상태, 또는 명확한 거절)
  | { kind: "unknown" };                         // 네트워크/해석 불가/서명 불일치 등 — 취소됐는지 모른다
export type LookupOutcome = { kind: "cancelled"; cancelTid: string; digest: string } | { kind: "paid" } | { kind: "unknown" };
export type NicepayRefundPort = {
  cancelAndConfirm(p: { tid: string; orderId: string; cancelOrderId: string; amount: number; reason: string }): Promise<CancelOutcome>;
  lookupCancelled(p: { tid: string; amount: number }): Promise<LookupOutcome>;
};
type DbResult = { data: Record<string, unknown> | null; error: { message: string } | null };
export type NicepayRefundDeps = {
  port: NicepayRefundPort;
  refundBegin(membershipId: string, uid: string): Promise<{ state: "locked" | "resumed" | "blocked" | "refunded"; reason?: string }>;
  refundRelease(membershipId: string, uid: string): Promise<DbResult>;
  recordPgCancel(orderId: string, pgTid: string, cancelTid: string, amount: number, digest: string): Promise<DbResult>;
  dbRefund(membershipId: string, uid: string, opts: { allowPg: boolean; skipTimeCheck: boolean }): Promise<DbResult>;
  log(level: "info" | "warn" | "error", event: string, fields: Record<string, unknown>): void;
};
type Reply = { status: number; body: Record<string, unknown> };
const stripPrefix = (m: string) => m.replace(/^.*?:\s*/, "");

export async function handleNicepayRefund(ctx: RefundCtx, uid: string, d: NicepayRefundDeps): Promise<Reply> {
  if (ctx.provider !== "nicepay" || ctx.amount <= 0) return { status: 400, body: { error: "NICEPAY 결제 환불이 아니에요" } };
  if (!ctx.paymentKey || !ctx.orderId) {
    d.log("error", "PG_REFUND_NO_PAYMENT_KEY", { membershipId: ctx.membershipId, orderId: ctx.orderId });
    return { status: 409, body: { error: "카드 결제 정보를 확인할 수 없어요. 센터에 문의해주세요", code: "no_payment_key" } };
  }
  const tid = ctx.paymentKey, orderId = ctx.orderId;
  let begin: Awaited<ReturnType<NicepayRefundDeps["refundBegin"]>>;
  try { begin = await d.refundBegin(ctx.membershipId, uid); } catch (e) {
    return { status: 400, body: { error: stripPrefix(e instanceof Error ? e.message : "환불을 시작하지 못했어요") } };
  }
  if (begin.state === "refunded") return { status: 409, body: { error: "이미 환불된 수강권이에요", code: "already_refunded" } };

  let cancelled: { cancelTid: string; digest: string };
  if (begin.state === "blocked") {
    // 환불 불가 사유(24시간 경과 등)라도, 이전 요청에서 PG 취소는 끝났고 DB 환불만 실패한 건이면 조회로 확인되는 경우에 한해 이어서 마무리한다.
    const look = await d.port.lookupCancelled({ tid, amount: ctx.amount });
    if (look.kind !== "cancelled") return { status: 409, body: { error: begin.reason ?? "환불할 수 없는 수강권이에요" } };
    cancelled = look;
  } else {
    const c = await d.port.cancelAndConfirm({ tid, orderId, cancelOrderId: `cx-${orderId}`, amount: ctx.amount, reason: "회원 환불 요청" });
    if (c.kind === "unknown") {
      d.log("error", "PG_REFUND_STATE_UNKNOWN", { membershipId: ctx.membershipId, tid: maskKey(tid) });
      return { status: 502, body: { error: "카드 결제 취소 결과를 확인하지 못했어요. 같은 요청을 다시 시도하면 이어서 확인해요", code: "pg_cancel_unknown" } };
    }
    if (c.kind === "rejected") {
      const rel = await d.refundRelease(ctx.membershipId, uid);
      if (rel.error) d.log("error", "PG_REFUND_RELEASE_FAILED", { membershipId: ctx.membershipId, dbError: rel.error.message });
      d.log("warn", "PG_REFUND_CANCEL_FAILED", { membershipId: ctx.membershipId, tid: maskKey(tid), code: c.code });
      return { status: 502, body: { error: "카드 결제를 취소하지 못했어요. 잠시 후 다시 시도해주세요(환불은 진행되지 않았어요)", code: "pg_cancel_failed" } };
    }
    cancelled = c;
  }

  // PG 취소가 확인됐다 → DB에 취소 기록을 남겨야 DB가 환불을 허용한다. 실패해도 환불 표시는 유지(다음 요청이 취소 재요청→이미 취소됨→조회→기록으로 이어간다).
  const rec = await d.recordPgCancel(orderId, tid, cancelled.cancelTid, ctx.amount, cancelled.digest).catch((e: unknown) => ({ data: null, error: { message: e instanceof Error ? e.message : "record failed" } }));
  if (rec.error) {
    d.log("error", "PG_REFUND_RECORD_CANCEL_FAILED", { membershipId: ctx.membershipId, tid: maskKey(tid), dbError: rec.error.message });
    return { status: 500, body: { error: "카드 결제는 취소됐지만 기록을 마치지 못했어요. 같은 요청을 다시 하면 이어서 처리돼요", code: "refund_record_failed_after_pg_cancel" } };
  }
  let r = await d.dbRefund(ctx.membershipId, uid, { allowPg: true, skipTimeCheck: true });
  if (r.error && !/이미 환불/.test(r.error.message)) r = await d.dbRefund(ctx.membershipId, uid, { allowPg: true, skipTimeCheck: true });
  if (r.error) {
    if (/이미 환불/.test(r.error.message)) return { status: 200, body: { ok: true, refunded: true, already: true } };
    d.log("error", "PG_REFUND_DB_FAILED_AFTER_PG_CANCEL", { membershipId: ctx.membershipId, tid: maskKey(tid), dbError: r.error.message });
    return { status: 500, body: { error: "카드 결제는 취소됐지만 환불 처리를 마치지 못했어요. 같은 요청을 다시 하면 이어서 처리돼요", code: "refund_db_failed_after_pg_cancel" } };
  }
  return { status: 200, body: { ok: true, ...(r.data ?? {}) } };
}

/* ---- 포트 구현: REST(v1) ---- */
export function restRefundPort(creds: RestCreds, fetchImpl: RestFetch, now: () => Date, log: RestDeps["log"]): NicepayRefundPort {
  const base = { creds, fetchImpl, now, log };
  return {
    cancelAndConfirm: (p) => cancelAndConfirm(base, p),
    async lookupCancelled(p) {
      const look = await restLookup(fetchImpl, creds, { tid: p.tid, now: now() });
      if (!look.ok || look.data.resultCode !== REST_OK || !verifyRestResponse(look.data, creds, { tid: p.tid })) return { kind: "unknown" };
      if (look.data.status === "paid") return { kind: "paid" };
      const bal = parseRestAmount(look.data.balanceAmt);
      if (look.data.status === "cancelled" && (bal === 0 || bal === null)) {
        const picked = typeof look.data.cancelledTid === "string" && look.data.cancelledTid ? look.data.cancelledTid : null;
        const cancelTid = picked && picked !== p.tid ? picked : `CX-${p.tid}`;   // DB는 취소 거래번호 = 승인 거래번호를 거부한다
        return { kind: "cancelled", cancelTid, digest: responseDigest([cancelTid, p.tid, p.amount, look.data.status, look.data.cancelledAt]) };
      }
      return { kind: "unknown" };
    },
  };
}

/* ---- 포트 구현: v3 MID 계열 ----
   v3에는 거래 조회 API가 문서에서 확인되지 않았다(BLOCKED) → 이미 취소된 거래의 재요청/blocked 이어하기는 항상 unknown(운영자 확인). 취소 응답은 Signature(= sha256(TID+MID+CancelAmt+Key))를 검증한다. */
export const NICEPAY_V3_CANCEL_URL = "https://webapi.nicepay.co.kr/webapi/cancel_process.jsp";   // ⚠ 계약 후 기술지원 확인 필요
export function v3RefundPort(creds: NicepayCreds, fetchImpl: NicepayFetch, now: () => Date): NicepayRefundPort {
  return {
    async cancelAndConfirm(p) {
      const r = await nicepayCancel(fetchImpl, creds, { cancelUrl: NICEPAY_V3_CANCEL_URL, tid: p.tid, cancelMoid: p.cancelOrderId, amount: p.amount, reason: p.reason, now: now() });
      if (!r.ok) return r.status === 0 || r.status >= 500 ? { kind: "unknown" } : { kind: "rejected", code: r.code };
      const amt = parseAmt(r.data.CancelAmt);
      const tid = typeof r.data.TID === "string" ? r.data.TID : "";
      const sigOk = amt === p.amount && tid.length > 0 && signatureMatches(nicepaySign.cancelResponse({ tid, mid: creds.mid, cancelAmt: String(r.data.CancelAmt) }, creds.merchantKey), r.data.Signature);
      if (!sigOk) return { kind: "unknown" };   // 서명/금액이 맞지 않는 취소 응답은 믿지 않는다
      const cancelTid = tid !== p.tid ? tid : `CX-${p.tid}`;   // 응답 TID가 원거래와 같으면 취소 거래번호가 따로 없다 → 결정적 식별자(규격 확인 필요)
      return { kind: "cancelled", cancelTid, digest: responseDigest([cancelTid, p.tid, p.amount, r.data.ResultCode, r.data.CancelDate]) };
    },
    async lookupCancelled() { return { kind: "unknown" }; },
  };
}
