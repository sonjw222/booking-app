/*
  NICEPAY REST(v1) 인증결제 서버 라이프사이클 — lifecycle.ts(v3 MID 계열)와 같은 상태 기계(claim → approving → 승인 검증 → 승인 기록 → DB 확정 / 보상 → release·review)를
  REST 규격으로 구현한 것. DB 의존성(NicepayDeps의 DB 부분)은 두 계열이 공유한다: nicepay_claim_order / nicepay_record_verified_approval / confirm_nicepay_payment / nicepay_record_pg_cancel / nicepay_release_order / nicepay_mark_review.
  신뢰 경계: 브라우저(returnUrl POST)가 보낸 값은 힌트다. ① authResultCode ② clientId ③ 인증 signature ④ DB 주문(소유·provider·금액·상태) ⑤ 승인 응답 서명·tid·orderId·금액·status 를 모두 확인해야만 DB가 수강권을 발급한다.
  보상 규칙(공식 문서 기준):
    · 승인 결과 불명(타임아웃/5xx/해석 불가) 또는 승인 응답이 검증 실패 → 망취소(netcancel, orderId 기준, 1시간 내). 성공이 확인되면 release(근거 netcancel_confirmed), 실패하면 review(주문은 approving 유지 — 임의로 성공·실패 확정 안 함).
    · 승인을 서버가 검증·기록한 뒤 DB 확정이 실패 → "일반 취소 API"(문서: 일반 취소는 취소 API) → 조회로 취소 재확인 → 취소 기록 → release. 확정 상태를 모르면 취소하지 않고 review.
  어디에서도 NICEPAY 호출을 직접 하지 않는다: fetchImpl은 주입된다(테스트는 가짜 PG).
*/
import { maskId, redactNicepayForLog } from "./redact";
import { responseDigest } from "./digest";
import type { NicepayDeps, NicepayOrderCtx } from "./lifecycle";
import { REST_OK, restApprove, restCancel, restLookup, restNetCancel, restSign, restSignatureMatches, parseRestAmount, verifyRestResponse, type RestCreds, type RestFetch, type RestResponse } from "./rest";

export type RestAuthResult = { authResultCode?: string; authResultMsg?: string; tid?: string; clientId?: string; orderId?: string; amount?: string | number; mallReserved?: string; authToken?: string; signature?: string; [k: string]: unknown };
export type RestDeps = Omit<NicepayDeps, "creds" | "fetchImpl"> & { creds: RestCreds; fetchImpl: RestFetch };
export type Reply = { status: number; body: Record<string, unknown> };
const s = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

/** 취소(일반 취소 API) 후 조회로 재확인: 취소가 서명 검증된 응답으로 확인됐을 때만 성공. */
export async function cancelAndConfirm(d: Pick<RestDeps, "creds" | "fetchImpl" | "now" | "log">, p: { tid: string; orderId: string; cancelOrderId: string; amount: number; reason: string }):
  Promise<{ kind: "cancelled"; cancelTid: string; digest: string } | { kind: "rejected"; code: string | null } | { kind: "unknown" }> {
  const r = await restCancel(d.fetchImpl, d.creds, { tid: p.tid, cancelOrderId: p.cancelOrderId, reason: p.reason, now: d.now() });
  if (!r.ok && r.status >= 400 && r.status < 500) {
    // 이미 취소된 거래의 재요청 등 — 문서에 응답 규격이 없으므로 "조회로 판단"한다(추측 금지).
  } else if (!r.ok) {
    d.log("warn", "PG_NICEPAY_CANCEL_UNKNOWN", { tid: maskId(p.tid), reason: r.code });
  } else if (r.data.resultCode !== REST_OK) {
    d.log("warn", "PG_NICEPAY_CANCEL_REJECTED", redactNicepayForLog(r.data));
  }
  const look = await restLookup(d.fetchImpl, d.creds, { tid: p.tid, now: d.now() });
  if (!look.ok) return !r.ok && r.status >= 400 && r.status < 500 ? { kind: "rejected", code: r.code } : { kind: "unknown" };
  const ld = look.data;
  if (ld.resultCode !== REST_OK || !verifyRestResponse(ld, d.creds, { tid: p.tid, orderId: undefined })) return { kind: "unknown" };   // 서명이 틀린 조회 응답은 믿지 않는다
  if (ld.status === "cancelled") {
    const bal = parseRestAmount(ld.balanceAmt);
    if (bal !== 0 && bal !== null) return { kind: "unknown" };   // 부분취소 상태 — 전액 취소가 아니면 확정하지 않는다
    // DB(nicepay_record_pg_cancel)는 취소 거래번호가 승인 거래번호와 같으면 거부한다. 문서상 전액취소의 cancelledTid는 원 tid와 같을 수 있으므로 그 경우 결정적 식별자를 쓴다.
    const fromCancel = r.ok && typeof r.data.cancelledTid === "string" && r.data.cancelledTid ? r.data.cancelledTid : null;
    const fromLookup = typeof ld.cancelledTid === "string" && ld.cancelledTid ? ld.cancelledTid : null;
    const picked = fromCancel ?? fromLookup;
    const cancelTid = picked && picked !== p.tid ? picked : `CX-${p.tid}`;
    return { kind: "cancelled", cancelTid, digest: responseDigest([cancelTid, p.tid, p.amount, ld.status, ld.cancelledAt]) };
  }
  if (ld.status === "paid") return { kind: "rejected", code: r.ok ? String(r.data.resultCode ?? "") : r.code };   // 아직 승인 상태 = 취소되지 않았음이 확실
  return { kind: "unknown" };
}

export async function handleNicepayRestAuthReturn(input: RestAuthResult, d: RestDeps): Promise<Reply> {
  const { creds } = d;
  const authToken = s(input.authToken), orderId = s(input.orderId), tid = s(input.tid), amountRaw = s(input.amount);
  if (!orderId || !s(input.clientId)) return { status: 400, body: { error: "결제 인증 결과가 올바르지 않아요", code: "bad_request" } };
  if (input.authResultCode !== "0000") {
    d.log("warn", "PG_NICEPAY_AUTH_FAILED", { authResultCode: s(input.authResultCode).slice(0, 8), orderId: maskId(orderId) });
    return { status: 400, body: { error: "결제 인증이 완료되지 않았어요", code: "auth_failed" } };
  }
  if (!authToken || !tid || !amountRaw || !s(input.signature)) return { status: 400, body: { error: "결제 인증 결과가 올바르지 않아요", code: "bad_request" } };
  if (input.clientId !== creds.clientId) return { status: 400, body: { error: "가맹점 정보가 일치하지 않아요", code: "mid_mismatch" } };
  if (!restSignatureMatches(restSign.authResult({ authToken, clientId: creds.clientId, amount: amountRaw }, creds.secretKey), input.signature)) {
    d.log("error", "PG_NICEPAY_SIGNATURE_MISMATCH", { stage: "auth", orderId: maskId(orderId) });
    return { status: 400, body: { error: "결제 인증값이 올바르지 않아요", code: "signature_mismatch" } };
  }
  const authAmt = parseRestAmount(amountRaw);
  const ctx = await d.orderContext(orderId);
  if (!ctx) return { status: 404, body: { error: "주문을 찾을 수 없어요" } };
  if (ctx.provider !== "nicepay") return { status: 400, body: { error: "NICEPAY 결제 주문이 아니에요" } };
  if (authAmt === null || authAmt !== ctx.amount) {
    d.log("error", "PG_NICEPAY_AMOUNT_MISMATCH", { stage: "auth", orderId: maskId(orderId) });
    return { status: 400, body: { error: "결제 금액이 주문 금액과 일치하지 않아요", code: "amount_mismatch" } };
  }
  if (ctx.status === "done") return { status: 200, body: { ok: true, already_done: true } };
  if (ctx.status !== "pending") return { status: 409, body: { error: "결제를 진행할 수 없는 주문 상태예요" } };
  if (!(await d.gateAllows(ctx.orderId))) return { status: 403, body: { error: "온라인 결제는 아직 사용할 수 없어요", code: "gate_off" } };
  const claimId = await d.claimOrder(ctx.orderId);
  if (!claimId) return { status: 409, body: { error: "이미 결제를 처리하고 있어요", code: "in_progress" } };

  let approvedTid: string | null = null;
  const review = async (reason: "netcancel_failed" | "confirm_state_unknown"): Promise<Reply> => {
    await d.markReview(ctx.orderId, claimId, reason).catch(() => d.log("error", "PG_NICEPAY_MARK_REVIEW_FAILED", { orderId: maskId(orderId) }));
    return { status: 500, body: { error: "결제 처리 중 문제가 생겼어요. 운영자에게 문의해주세요", code: "compensation_failed" } };
  };
  // 승인 결과를 모를 때(또는 승인 응답이 신뢰 불가) — 망취소. 망취소 응답은 문서에 서명 공식이 없어 그 응답만으로 "취소됨"을 확정하지 않는다:
  // 망취소 뒤 서명 검증된 조회로 거래가 승인(paid) 상태가 아님을 확인한 경우에만 release, paid가 남았거나 조회를 신뢰할 수 없으면 review(운영자 확인).
  const netCancelAndRelease = async (cause: string, body: Reply["body"], status: number): Promise<Reply> => {
    const r = await restNetCancel(d.fetchImpl, creds, { orderId: ctx.orderId, now: d.now() });
    if (!r.ok || r.data.resultCode !== REST_OK) { d.log("error", "PG_NICEPAY_NETCANCEL_FAILED", { orderId: maskId(orderId), cause, reason: r.ok ? s(r.data.resultCode) : r.message }); return review("netcancel_failed"); }
    const after = await restLookup(d.fetchImpl, creds, { tid, now: d.now() });
    const ad = after.ok ? after.data : null;
    const trusted = !!ad && ad.resultCode === REST_OK && verifyRestResponse(ad, creds, { tid, orderId: ctx.orderId });
    if (!trusted || ad!.status === "paid" || ad!.status === "partialCancelled") { d.log("error", "PG_NICEPAY_NETCANCEL_NOT_VERIFIED", { orderId: maskId(orderId), cause, lookup: trusted ? s(ad!.status) : "untrusted" }); return review("netcancel_failed"); }
    d.log("warn", "PG_NICEPAY_NETCANCELED", { orderId: maskId(orderId), cause });
    return releaseAfter(status, body);
  };
  const releaseAfter = async (status: number, body: Reply["body"]): Promise<Reply> => {
    const released = await d.releaseOrder(ctx.orderId, claimId, "netcancel_confirmed");
    return released ? { status, body } : review("netcancel_failed");
  };
  // 승인을 서버가 검증·기록한 뒤의 DB 실패 — 일반 취소 + 조회 재확인 + 취소 기록.
  const cancelVerifiedApproval = async (cause: string, body: Reply["body"], status: number): Promise<Reply> => {
    const c = await cancelAndConfirm(d, { tid: approvedTid ?? tid, orderId: ctx.orderId, cancelOrderId: `cx-${ctx.orderId}`, amount: ctx.amount, reason: "결제 확정 실패 자동 취소" });
    if (c.kind !== "cancelled") { d.log("error", "PG_NICEPAY_CANCEL_NOT_CONFIRMED", { orderId: maskId(orderId), cause, kind: c.kind }); return review("netcancel_failed"); }
    const cr = await d.recordPgCancel(ctx.orderId, approvedTid ?? tid, c.cancelTid, ctx.amount, c.digest).catch((e: unknown) => ({ data: null, error: { message: e instanceof Error ? e.message : "record failed" } }));
    if (cr.error) { d.log("error", "PG_NICEPAY_RECORD_CANCEL_FAILED", { orderId: maskId(orderId), reason: cr.error.message }); return review("netcancel_failed"); }
    return releaseAfter(status, body);
  };

  // 3) 서버가 검증한 승인 기록 → DB 확정 (승인 응답 또는 서명 검증된 조회 응답 r 기준)
  const finishApproved = async (r: RestResponse): Promise<Reply> => {
    const digest = responseDigest([tid, ctx.orderId, ctx.amount, creds.clientId, r.resultCode, r.paidAt]);
    let res = await d.recordVerifiedApproval(ctx.orderId, claimId, tid, ctx.amount, digest);
    if (!res.error) { approvedTid = tid; res = await d.dbConfirm(ctx.orderId, claimId, tid, ctx.amount); }
    if (!res.error) return { status: 200, body: { ok: true, ...(res.data ?? {}) } };
    let after: NicepayOrderCtx | null = null;
    try { after = await d.orderContext(orderId); } catch { after = null; }
    if (after?.status === "done") return { status: 200, body: { ok: true, already_done: true } };
    if (!after) {
      d.log("error", "PG_NICEPAY_CONFIRM_STATE_UNKNOWN", { orderId: maskId(orderId), tid: maskId(tid), dbError: res.error.message });
      await d.markReview(ctx.orderId, claimId, "confirm_state_unknown").catch(() => d.log("error", "PG_NICEPAY_MARK_REVIEW_FAILED", { orderId: maskId(orderId) }));
      return { status: 500, body: { error: "결제는 승인됐지만 확정 상태를 확인하지 못했어요. 운영자에게 문의해주세요", code: "confirm_state_unknown" } };
    }
    if (!approvedTid) {
      // 승인 기록 자체가 실패 — 서버가 승인을 DB에 남기지 못했다. 승인은 이미 일어났으므로 netcancel이 아니라 일반 취소 경로로 정리하되, DB에는 취소 기록 대상(승인 기록)이 없다 → 운영자 확인.
      return review("netcancel_failed");
    }
    return cancelVerifiedApproval("db_confirm_failed", { error: "결제 확정에 실패해 승인을 취소했어요", code: "db_confirm_failed" }, 500);
  };

  // 1) 승인(돈이 움직이는 시점) — 금액은 DB 주문 금액
  const approved = await restApprove(d.fetchImpl, creds, { tid, amount: ctx.amount, now: d.now() });
  if (!approved.ok) {
    if (approved.status === 0 || approved.status >= 500) {
      d.log("error", "PG_NICEPAY_APPROVE_UNKNOWN", { orderId: maskId(orderId), reason: approved.code });
      // 승인 결과를 모른다 → 망취소 전에 먼저 거래 상태를 조회한다(서명·tid·orderId 검증).
      //   paid + 금액 일치 : 승인은 실제로 성공 — 취소하지 않고 이 조회 결과를 승인 응답으로 삼아 DB 확정을 이어간다.
      //   ready/failed/expired : 돈이 움직이지 않았다 — 망취소 없이 release.  cancelled : 이미 취소됨 — release.
      //   그 밖(금액 불일치 paid, 부분취소, 조회 실패/서명 불일치) : 기존대로 망취소 후 재확인.
      const look = await restLookup(d.fetchImpl, creds, { tid, now: d.now() });
      const ld = look.ok ? look.data : null;
      if (ld && ld.resultCode === REST_OK && verifyRestResponse(ld, creds, { tid, orderId: ctx.orderId })) {
        if (ld.status === "paid" && parseRestAmount(ld.amount) === ctx.amount) return finishApproved(ld);
        if (ld.status === "ready" || ld.status === "failed" || ld.status === "expired") {
          d.log("warn", "PG_NICEPAY_APPROVE_UNKNOWN_NOT_PAID", { orderId: maskId(orderId), pgStatus: s(ld.status) });
          return (await d.releaseOrder(ctx.orderId, claimId, "approve_rejected")) ? { status: 502, body: { error: "결제 승인 결과를 확인하지 못했어요. 다시 시도해주세요", code: "approve_unknown" } } : review("netcancel_failed");
        }
        if (ld.status === "cancelled") return releaseAfter(502, { error: "결제 승인 결과를 확인하지 못했어요. 다시 시도해주세요", code: "approve_unknown" });
      }
      return netCancelAndRelease("approve_unknown", { error: "결제 승인 결과를 확인하지 못했어요. 다시 시도해주세요", code: "approve_unknown" }, 502);
    }
    await d.releaseOrder(ctx.orderId, claimId, "approve_rejected");
    return { status: 400, body: { error: "결제 승인에 실패했어요", code: "approve_failed" } };
  }
  const r = approved.data;
  if (r.resultCode !== REST_OK) {
    d.log("warn", "PG_NICEPAY_APPROVE_REJECTED", redactNicepayForLog({ ResultCode: s(r.resultCode), ResultMsg: s(r.resultMsg) }));
    await d.releaseOrder(ctx.orderId, claimId, "approve_rejected");
    return { status: 400, body: { error: "결제 승인에 실패했어요", code: "approve_failed" } };
  }
  // 2) 승인 응답 검증 — 서명·tid·orderId·금액·status. 하나라도 어긋나면 승인 상태를 신뢰할 수 없으므로 망취소.
  if (r.status !== "paid" || !verifyRestResponse(r, creds, { tid, orderId: ctx.orderId, amount: ctx.amount })) {
    d.log("error", "PG_NICEPAY_APPROVE_MISMATCH", { orderId: maskId(orderId), status: s(r.status) });
    return netCancelAndRelease("approve_mismatch", { error: "결제 승인 응답이 주문과 일치하지 않아요", code: "approve_mismatch" }, 409);
  }
  return finishApproved(r);
}

/* 웹훅(결제통보): 문서상 signature(= sha256(tid + amount + ediDate + SecretKey))가 있다 → 서명을 검증하되, 웹훅만으로 주문을 확정/취소하지는 않는다(분류 전용, 상태 변경은 조회 재확인 후).
   verdict: bad_signature(거부, 알림) | unknown_order | mismatch(금액/상태 불일치 → 운영 확인) | confirm_needed(승인됐는데 DB 미확정 → 조회로 확인 후 복구) | ignore */
export type RestWebhookVerdict = "bad_signature" | "bad_payload" | "unknown_order" | "mismatch" | "confirm_needed" | "ignore";
export async function classifyRestWebhook(payload: Record<string, unknown>, d: Pick<RestDeps, "orderContext" | "log" | "creds">): Promise<RestWebhookVerdict> {
  const tid = s(payload.tid), orderId = s(payload.orderId), ediDate = s(payload.ediDate), amt = parseRestAmount(payload.amount);
  if (!tid || !orderId || !ediDate || amt === null) return "bad_payload";
  if (!restSignatureMatches(restSign.response({ tid, amount: String(amt), ediDate }, d.creds.secretKey), payload.signature)) { d.log("error", "PG_NICEPAY_WEBHOOK_BAD_SIGNATURE", { orderId: maskId(orderId) }); return "bad_signature"; }
  const ctx = await d.orderContext(orderId);
  if (!ctx || ctx.provider !== "nicepay") return "unknown_order";
  if (ctx.amount !== amt) { d.log("error", "PG_NICEPAY_WEBHOOK_MISMATCH", { orderId: maskId(orderId), tid: maskId(tid) }); return "mismatch"; }
  const status = s(payload.status);
  if (status === "paid") return ctx.status === "done" ? "ignore" : "confirm_needed";
  if (status === "cancelled" || status === "partialCancelled") return ctx.status === "done" ? "mismatch" : "ignore";   // 취소 통보인데 DB는 done(환불 기록 없음 가능) → 운영 확인
  return "ignore";
}
