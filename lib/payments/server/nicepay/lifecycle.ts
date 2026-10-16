/*
  NICEPAY 단건 결제 서버 라이프사이클(설계 구현, 오프라인 전용) — ⚠ 어떤 라우트에도 연결되지 않았다. 모든 의존성은 주입되며 테스트는 가짜 의존성만 쓴다.
  흐름: 주문 생성(DB, provider='nicepay', pending) → 결제창(브라우저, MID/키 필요) → returnUrl POST(인증 결과) → [이 함수] 서버 승인 → 금액·주문 검증 → DB 확정.

  신뢰 경계(브라우저가 보낸 값은 힌트):
    · 인증 결과의 Signature(= sha256(AuthToken+MID+Amt+MerchantKey))를 먼저 검증한다 — MerchantKey 없이는 만들 수 없다.
    · 금액: 승인 요청에는 항상 DB 주문 금액을 쓰고, 인증결과 Amt·승인응답 Amt가 모두 DB 금액과 같아야 한다.
    · 주문: Moid로 DB 주문을 읽어 provider/상태를 확인한다. done이면 멱등 성공, cancelled·기타는 승인하지 않는다.
    · NextAppURL/NetCancelURL은 허용 호스트일 때만 사용(AuthToken이 외부로 나가지 않게).
    · 중복 확정 방지: claimOrder(원자적 pending→approving 선점)에 실패하면 승인 호출 없이 409. 최종 DB 확정은 멱등 RPC에 맡긴다.
  돈이 움직이는 시점: 승인 응답 3001. 이후 단계가 하나라도 실패하면 망취소(NetCancel)한다. 승인 요청 자체의 응답을 못 받은 경우(status 0)에도 망취소를 시도한다.
  DB 확정 실패: 실제로 커밋됐는지 재조회해 done이면 취소하지 않고, 상태를 모르면(재조회 실패) 자동 취소하지 않고 운영 알림만 남긴다(Toss lifecycle과 같은 원칙).
  로그: redactNicepayForLog 허용 목록만 기록(카드번호·구매자 정보·토큰·서명·키 제외).
*/
import { nicepaySign, signatureMatches, parseAmt } from "./signature";
import { nicepayApprove, nicepayNetCancel, type NicepayCreds, type NicepayFetch } from "./api";
import { redactNicepayForLog, maskId } from "./redact";
import { isAllowedNicepayUrl, NICEPAY_APPROVE_OK_CARD, NICEPAY_AUTH_OK, type NicepayAuthResult } from "./types";

export type NicepayOrderCtx = { orderId: string; status: string; amount: number; provider: string | null };
type DbResult = { data: Record<string, unknown> | null; error: { message: string } | null };
export type NicepayDeps = {
  creds: NicepayCreds;
  fetchImpl: NicepayFetch;
  now(): Date;
  orderContext(orderId: string): Promise<NicepayOrderCtx | null>;
  /** PG 게이트(PG_CHECKOUT_ENABLED 또는 심사용 override 계정). false면 NICEPAY를 호출하지 않는다 — Toss lifecycle의 gateAllows와 같은 규칙. */
  gateAllows(orderId: string): Promise<boolean>;
  /** pending → approving 원자적 선점(DB nicepay_claim_order). 성공하면 이 선점의 claimId(이후 모든 호출의 fencing 값), 이미 선점됐거나 pending이 아니면 null. */
  claimOrder(orderId: string): Promise<string | null>;
  /** 승인이 확정 거절됐거나(approve_rejected) 망취소 성공이 확인된(netcancel_confirmed) 뒤에만 approving → pending 복귀(재시도 허용). 근거는 DB 감사 기록에 남는다 */
  releaseOrder(orderId: string, claimId: string, basis: "approve_rejected" | "netcancel_confirmed"): Promise<void>;
  /** 결과 불명/보상 실패 주문을 운영자 확인 대기로 표시(주문은 approving으로 유지해 재승인을 막는다). 로그만이 아닌 영속 표시 — 복구 절차는 docs/payments/NICEPAY_SERVER_MODULE_VERIFICATION.md */
  markReview(orderId: string, claimId: string, reason: "netcancel_failed" | "confirm_state_unknown"): Promise<void>;
  dbConfirm(orderId: string, claimId: string, tid: string, amount: number): Promise<DbResult>;
  log(level: "info" | "warn" | "error", event: string, fields: Record<string, unknown>): void;
};
export type Reply = { status: number; body: Record<string, unknown> };
const s = (v: unknown) => (typeof v === "string" ? v : "");

export async function handleNicepayAuthReturn(input: NicepayAuthResult, d: NicepayDeps): Promise<Reply> {
  const { creds } = d;
  const authToken = s(input.AuthToken), moid = s(input.Moid), tid = s(input.TxTid), amtRaw = s(input.Amt);
  if (!authToken || !moid || !tid || !amtRaw || !s(input.MID) || !s(input.Signature)) return { status: 400, body: { error: "결제 인증 결과가 올바르지 않아요", code: "bad_request" } };
  if (input.AuthResultCode !== NICEPAY_AUTH_OK) {
    d.log("warn", "PG_NICEPAY_AUTH_FAILED", redactNicepayForLog(input));
    return { status: 400, body: { error: "결제 인증이 완료되지 않았어요", code: "auth_failed" } };
  }
  if (input.MID !== creds.mid) return { status: 400, body: { error: "가맹점 정보가 일치하지 않아요", code: "mid_mismatch" } };
  if (!signatureMatches(nicepaySign.authResult({ authToken, mid: creds.mid, amt: amtRaw }, creds.merchantKey), input.Signature)) {
    d.log("error", "PG_NICEPAY_SIGNATURE_MISMATCH", { stage: "auth", moid: maskId(moid) });
    return { status: 400, body: { error: "결제 인증값이 올바르지 않아요", code: "signature_mismatch" } };
  }
  const authAmt = parseAmt(amtRaw);
  const ctx = await d.orderContext(moid);
  if (!ctx) return { status: 404, body: { error: "주문을 찾을 수 없어요" } };
  if (ctx.provider !== "nicepay") return { status: 400, body: { error: "NICEPAY 결제 주문이 아니에요" } };
  if (authAmt === null || authAmt !== ctx.amount) {
    d.log("error", "PG_NICEPAY_AMOUNT_MISMATCH", { stage: "auth", moid: maskId(moid) });
    return { status: 400, body: { error: "결제 금액이 주문 금액과 일치하지 않아요", code: "amount_mismatch" } };
  }
  if (ctx.status === "done") return { status: 200, body: { ok: true, already_done: true } };
  if (ctx.status !== "pending") return { status: 409, body: { error: "결제를 진행할 수 없는 주문 상태예요" } };
  if (!(await d.gateAllows(ctx.orderId))) return { status: 403, body: { error: "온라인 결제는 아직 사용할 수 없어요", code: "gate_off" } };
  if (!isAllowedNicepayUrl(input.NextAppURL) || !isAllowedNicepayUrl(input.NetCancelURL)) {
    d.log("error", "PG_NICEPAY_URL_REJECTED", { moid: maskId(moid) });
    return { status: 400, body: { error: "결제 서버 주소가 올바르지 않아요", code: "url_rejected" } };
  }
  const nextAppUrl = input.NextAppURL, netCancelUrl = input.NetCancelURL;
  const claimId = await d.claimOrder(ctx.orderId);
  if (!claimId) return { status: 409, body: { error: "이미 결제를 처리하고 있어요", code: "in_progress" } };

  const netCancel = async (cause: string): Promise<boolean> => {
    const r = await nicepayNetCancel(d.fetchImpl, creds, { netCancelUrl, tid, authToken, amount: ctx.amount, now: d.now() });
    if (!r.ok) d.log("error", "PG_NICEPAY_NETCANCEL_FAILED", { moid: maskId(moid), tid: maskId(tid), cause, reason: r.message });
    else d.log("warn", "PG_NICEPAY_NETCANCELED", { moid: maskId(moid), tid: maskId(tid), cause });
    return r.ok;
  };
  const failAfterApprove = async (cause: string, body: Reply["body"], status = 409): Promise<Reply> => {
    const ok = await netCancel(cause);
    if (ok) { await d.releaseOrder(ctx.orderId, claimId, "netcancel_confirmed"); return { status, body }; }
    // 취소 실패 — 돈이 승인된 채일 수 있다. 주문은 approving으로 두어 재승인을 막고 운영자 확인 대기로 표시한다(성공/실패를 임의로 확정하지 않는다).
    await d.markReview(ctx.orderId, claimId, "netcancel_failed").catch(() => d.log("error", "PG_NICEPAY_MARK_REVIEW_FAILED", { moid: maskId(moid) }));
    return { status: 500, body: { error: "결제 처리 중 문제가 생겼어요. 운영자에게 문의해주세요", code: "compensation_failed" } };
  };

  // 1) 승인(돈이 움직이는 시점) — 금액은 DB 주문 금액
  const approved = await nicepayApprove(d.fetchImpl, creds, { nextAppUrl, tid, authToken, amount: ctx.amount, now: d.now() });
  if (!approved.ok) {
    if (approved.status === 0 || approved.status >= 500) {
      // 응답을 못 받았거나 5xx — 승인됐는지 모른다. 망취소로 거래를 정리한다.
      d.log("error", "PG_NICEPAY_APPROVE_UNKNOWN", { moid: maskId(moid), reason: approved.code });
      return failAfterApprove("approve_unknown", { error: "결제 승인 결과를 확인하지 못했어요. 다시 시도해주세요", code: "approve_unknown" }, 502);
    }
    await d.releaseOrder(ctx.orderId, claimId, "approve_rejected");
    return { status: 400, body: { error: "결제 승인에 실패했어요", code: "approve_failed" } };
  }
  const r = approved.data;
  if (r.ResultCode !== NICEPAY_APPROVE_OK_CARD) {
    d.log("warn", "PG_NICEPAY_APPROVE_REJECTED", redactNicepayForLog(r));
    await d.releaseOrder(ctx.orderId, claimId, "approve_rejected");
    return { status: 400, body: { error: "결제 승인에 실패했어요", code: "approve_failed" } };
  }
  // 2) 승인 응답 검증 — 하나라도 어긋나면 승인된 돈을 되돌린다
  const respTid = s(r.TID), respAmt = parseAmt(r.Amt);
  const sigOk = signatureMatches(nicepaySign.approveResponse({ tid: respTid, mid: creds.mid, amt: s(r.Amt) }, creds.merchantKey), r.Signature);
  if (!sigOk || respTid !== tid || r.Moid !== ctx.orderId || r.MID !== creds.mid || respAmt !== ctx.amount) {
    d.log("error", "PG_NICEPAY_APPROVE_MISMATCH", { moid: maskId(moid), signature: sigOk, tid: respTid === tid, moidMatches: r.Moid === ctx.orderId, amount: respAmt === ctx.amount });
    return failAfterApprove("approve_mismatch", { error: "결제 승인 응답이 주문과 일치하지 않아요", code: "approve_mismatch" });
  }
  // 3) DB 확정
  const res = await d.dbConfirm(ctx.orderId, claimId, respTid, ctx.amount);
  if (!res.error) return { status: 200, body: { ok: true, ...(res.data ?? {}) } };
  let after: NicepayOrderCtx | null = null;
  try { after = await d.orderContext(moid); } catch { after = null; }
  if (after?.status === "done") return { status: 200, body: { ok: true, already_done: true } };
  if (!after) {
    d.log("error", "PG_NICEPAY_CONFIRM_STATE_UNKNOWN", { moid: maskId(moid), tid: maskId(tid), dbError: res.error.message });
    await d.markReview(ctx.orderId, claimId, "confirm_state_unknown").catch(() => d.log("error", "PG_NICEPAY_MARK_REVIEW_FAILED", { moid: maskId(moid) }));
    return { status: 500, body: { error: "결제는 승인됐지만 확정 상태를 확인하지 못했어요. 운영자에게 문의해주세요", code: "confirm_state_unknown" } };
  }
  return failAfterApprove("db_confirm_failed", { error: "결제 확정에 실패해 승인을 취소했어요", code: "db_confirm_failed" }, 500);
}

/* ---- 웹훅(결제통보) ----
  문서상 웹훅에는 서명 검증 방식이 없다 → 웹훅 값만으로 주문을 확정하거나 취소하지 않는다(힌트 전용).
  확인 후 처리: ResultCode/TID/Amt를 DB 주문과 대조해 'confirm_needed'(승인 응답 유실·미확정)·'mismatch'(운영 알림)·'ignore'(이미 처리)로 분류만 한다.
  실제 상태 변경은 별도 조회 API(공식 문서 확인 필요, BLOCKED) 또는 운영자 확인 후에만 한다. 웹훅 수신 라우트는 이번 범위에서 만들지 않는다. */
export type NicepayWebhookVerdict = "ignore" | "confirm_needed" | "mismatch" | "unknown_order" | "bad_payload";
export async function classifyNicepayWebhook(payload: Record<string, unknown>, d: Pick<NicepayDeps, "orderContext" | "log" | "creds">): Promise<NicepayWebhookVerdict> {
  const moid = s(payload.MOID) || s(payload.Moid), tid = s(payload.TID), amt = parseAmt(payload.Amt);
  if (!moid || !tid || amt === null || payload.MID !== d.creds.mid) { d.log("warn", "PG_NICEPAY_WEBHOOK_BAD", redactNicepayForLog(payload)); return "bad_payload"; }
  const ctx = await d.orderContext(moid);
  if (!ctx || ctx.provider !== "nicepay") return "unknown_order";
  if (ctx.amount !== amt) { d.log("error", "PG_NICEPAY_WEBHOOK_MISMATCH", { moid: maskId(moid), tid: maskId(tid) }); return "mismatch"; }
  if (payload.StateCd !== "0") return ctx.status === "done" ? "mismatch" : "ignore";   // 취소 통보인데 DB는 done → 운영 확인 필요
  return ctx.status === "done" ? "ignore" : "confirm_needed";
}
