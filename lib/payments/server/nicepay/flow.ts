/*
  NICEPAY 구매 흐름의 HTTP 경계(순수 핸들러) — 라우트(app/api/payments/nicepay/*)는 이 핸들러에 실제 의존성만 주입한다. 테스트는 가짜 의존성/가짜 PG로 라우트 없이 전 단계를 검증한다.
    prepare   : 결제창 호출 파라미터를 서버가 만든다(금액=DB 주문, 소유·상태·게이트 확인) + 주문 전용 복귀 토큰(rt) 발급.
    return    : NICEPAY가 결제창 인증 결과를 returnUrl로 POST → 토큰·소유 확인 → 서버 승인(restLifecycle/lifecycle) → 결과 화면으로 303. 브라우저에는 성공/실패를 직접 말하지 않는다.
    status    : 결과 화면이 폴링. 성공(done)은 DB 상태가 done일 때만 말한다 — "결제 성공 화면에 들어왔다"는 사실만으로 구매 성공이 되지 않는다.
    abandon   : 승인 전(pending) 주문만 취소. approving(승인 진행 중)이면 거부(진행 중 취소 경합은 DB 트리거가 최종 방어).
    webhook   : 서명 검증 + 분류만(상태 변경 없음).
  브라우저 값은 힌트: 금액/상품/회원은 모두 서버가 DB 주문에서 읽는다. 복귀 토큰은 "이 uid의 이 주문" 권한만 담은 짧은 서명 토큰(returnToken.ts)이다.
*/
import { mintReturnToken, verifyReturnToken } from "../returnToken";
import { nicepaySign } from "./signature";
import { ediDateOf } from "./api";
import { handleNicepayRestAuthReturn, classifyRestWebhook, type RestDeps } from "./restLifecycle";
import { handleNicepayAuthReturn, classifyNicepayWebhook, type NicepayDeps } from "./lifecycle";
import type { NicepayConfig } from "./config";
import { maskId } from "./redact";
import { isMemberPassMoid } from "../../domains";

export type Reply = { status: number; body: Record<string, unknown> };
export type OrderView = { orderId: string; status: string; amount: number; provider: string | null };
export type FlowDeps = {
  config: NicepayConfig;
  returnTokenSecret: string;
  getAuthUid(token: string): Promise<string | null>;
  ownedOrder(orderId: string, uid: string): Promise<OrderView | null>;
  gateAllows(orderId: string): Promise<boolean>;
  /** pending → cancelled (service_role, provider='nicepay'만). pending이 아니면 false. */
  cancelPendingOrder(orderId: string): Promise<boolean>;
  /** nicepay_order_context + reviewPending */
  orderState(orderId: string): Promise<{ status: string; reviewPending: boolean } | null>;
  rest?: RestDeps;
  v3?: NicepayDeps;
  log(level: "info" | "warn" | "error", event: string, fields: Record<string, unknown>): void;
};

const dbStatusToState = (st: { status: string; reviewPending: boolean } | null): "done" | "cancelled" | "review" | "processing" | "pending" | "unknown" => {
  if (!st) return "unknown";
  if (st.status === "done") return "done";
  if (st.status === "cancelled") return "cancelled";
  if (st.reviewPending) return "review";
  if (st.status === "approving" || st.status === "paid") return "processing";
  if (st.status === "pending") return "pending";
  return "unknown";
};

async function uidFrom(input: { token?: string | null; returnToken?: unknown; orderId: string }, d: FlowDeps): Promise<string | null> {
  if (input.token) { const u = await d.getAuthUid(input.token); if (u) return u; }
  if (typeof input.returnToken === "string") { const v = verifyReturnToken(d.returnTokenSecret, input.returnToken, input.orderId); if (v.ok) return v.uid; }
  return null;
}

const goodsNameOf = (raw: unknown) => (typeof raw === "string" && raw.trim() ? Array.from(raw.trim()).slice(0, 20).join("") : "모하빗 수강권");   // 표시용(최대 40바이트 이내로 짧게). 금액/상품 결정에 쓰지 않는다

export async function handlePrepare(input: { token: string | null; orderId?: unknown; orderName?: unknown }, d: FlowDeps, now: Date = new Date()): Promise<Reply> {
  if (!isMemberPassMoid(input.orderId)) return { status: 400, body: { error: "orderId가 올바르지 않아요" } };   // 회원 수강권 주문(UUID)만 — 구독 결제 주문번호는 이 도메인에 들어오지 못한다
  const uid = input.token ? await d.getAuthUid(input.token) : null;
  if (!uid) return { status: 401, body: { error: "로그인이 필요해요" } };
  const ctx = await d.ownedOrder(input.orderId, uid);
  if (!ctx) return { status: 404, body: { error: "주문을 찾을 수 없어요" } };
  if (ctx.provider !== "nicepay") return { status: 400, body: { error: "NICEPAY 결제 주문이 아니에요" } };
  if (ctx.status !== "pending") return { status: 409, body: { error: "결제를 진행할 수 없는 주문 상태예요" } };
  if (!(await d.gateAllows(ctx.orderId))) return { status: 403, body: { error: "온라인 결제는 아직 사용할 수 없어요", code: "gate_off" } };
  const rt = mintReturnToken(d.returnTokenSecret, { orderId: ctx.orderId, uid });
  const c = d.config;
  const returnUrl = `${c.returnBaseUrl}/api/payments/nicepay/return?rt=${encodeURIComponent(rt)}`;
  const resultUrl = `${c.returnBaseUrl}/checkout/nicepay/result?orderId=${encodeURIComponent(ctx.orderId)}&rt=${encodeURIComponent(rt)}`;
  if (c.family === "rest_v1") {
    return { status: 200, body: { ok: true, family: "rest_v1", sdkUrl: c.sdkUrl, resultUrl, params: { clientId: c.clientId, method: "card", orderId: ctx.orderId, amount: ctx.amount, goodsName: goodsNameOf(input.orderName), returnUrl } } };
  }
  const ediDate = ediDateOf(now), amt = String(ctx.amount);
  return { status: 200, body: { ok: true, family: "v3_mid", resultUrl, params: { MID: c.mid, Moid: ctx.orderId, Amt: amt, GoodsName: goodsNameOf(input.orderName), EdiDate: ediDate, SignData: nicepaySign.payRequest({ ediDate, mid: c.mid, amt }, c.merchantKey), ReturnURL: returnUrl, PayMethod: "CARD", CharSet: "utf-8" } } };
}

/** NICEPAY → returnUrl POST. 항상 결과 화면 경로를 돌려준다(상태는 쿼리에 싣지 않는다 — 결과 화면이 status로 DB 진실을 읽는다). */
export async function handleReturnPost(form: Record<string, unknown>, rt: string | null, d: FlowDeps): Promise<{ location: string }> {
  const family = d.config.family;
  const orderId = String((family === "rest_v1" ? form.orderId : form.Moid) ?? "");
  const where = (extra = "") => ({ location: `${d.config.returnBaseUrl}/checkout/nicepay/result?orderId=${encodeURIComponent(orderId)}${rt ? `&rt=${encodeURIComponent(rt)}` : ""}${extra}` });
  const invalid = { location: `${d.config.returnBaseUrl}/checkout/nicepay/result?invalid=1` };
  if (!isMemberPassMoid(orderId) || !rt) return invalid;
  const v = verifyReturnToken(d.returnTokenSecret, rt, orderId);
  if (!v.ok) { d.log("warn", "PG_NICEPAY_RETURN_TOKEN_REJECTED", { reason: v.reason, orderId: maskId(orderId) }); return invalid; }
  const owned = await d.ownedOrder(orderId, v.uid);
  if (!owned || owned.provider !== "nicepay") return invalid;
  const authCode = String((family === "rest_v1" ? form.authResultCode : form.AuthResultCode) ?? "");
  if (authCode !== "0000") {
    // 인증 실패/사용자 취소 — 승인 전이므로 pending 주문만 취소(포인트 복원은 DB 트리거). 이미 처리 중이면 건드리지 않는다.
    await d.cancelPendingOrder(orderId).catch(() => false);
    return where("&failed=1");
  }
  let rejected = false;   // 서버가 이 인증 결과를 명확히 거절했다(서명/금액/MID 불일치·승인 거절 등) — 결과 화면이 오래 기다리지 않고 바로 실패 안내를 보이게 한다. 진행 중(in_progress)·예외(상태 불명)는 계속 확인한다.
  try {
    const rep = family === "rest_v1" && d.rest ? await handleNicepayRestAuthReturn(form, d.rest) : family === "v3_mid" && d.v3 ? await handleNicepayAuthReturn(form, d.v3) : null;
    if (rep && rep.status >= 400 && (rep.body as { code?: unknown }).code !== "in_progress") rejected = true;
  } catch (e) {
    d.log("error", "PG_NICEPAY_RETURN_HANDLER_THROW", { orderId: maskId(orderId), error: e instanceof Error ? e.message.slice(0, 120) : "unknown" });
  }
  return where(rejected ? "&failed=1" : "");
}

export async function handleStatus(input: { token: string | null; returnToken?: unknown; orderId?: unknown }, d: FlowDeps): Promise<Reply> {
  if (!isMemberPassMoid(input.orderId)) return { status: 400, body: { error: "orderId가 올바르지 않아요" } };
  const uid = await uidFrom({ token: input.token, returnToken: input.returnToken, orderId: input.orderId }, d);
  if (!uid) return { status: 401, body: { error: "로그인이 필요하거나 확인 정보가 만료됐어요" } };
  const owned = await d.ownedOrder(input.orderId, uid);
  if (!owned || owned.provider !== "nicepay") return { status: 404, body: { error: "주문을 찾을 수 없어요" } };
  const st = await d.orderState(owned.orderId);
  const state = dbStatusToState(st);
  return { status: 200, body: { ok: true, state, final: state === "done" || state === "cancelled" || state === "review" } };
}

export async function handleAbandon(input: { token: string | null; returnToken?: unknown; orderId?: unknown }, d: FlowDeps): Promise<Reply> {
  if (!isMemberPassMoid(input.orderId)) return { status: 400, body: { error: "orderId가 올바르지 않아요" } };
  const uid = await uidFrom({ token: input.token, returnToken: input.returnToken, orderId: input.orderId }, d);
  if (!uid) return { status: 401, body: { error: "로그인이 필요해요" } };
  const owned = await d.ownedOrder(input.orderId, uid);
  if (!owned || owned.provider !== "nicepay") return { status: 404, body: { error: "주문을 찾을 수 없어요" } };
  if (owned.status === "cancelled") return { status: 200, body: { ok: true, cancelled: true, already: true } };
  if (owned.status !== "pending") return { status: 409, body: { error: "이미 결제가 진행되었거나 완료된 주문은 취소할 수 없어요", code: "in_progress" } };
  const ok = await d.cancelPendingOrder(owned.orderId);
  return ok ? { status: 200, body: { ok: true, cancelled: true } } : { status: 409, body: { error: "결제가 진행 중이라 취소할 수 없어요", code: "in_progress" } };
}

/** 웹훅: 서명 검증 + 분류만. 문서 규격상 응답은 200 text/html "OK". 잘못된 서명은 401. */
export async function handleWebhook(payload: Record<string, unknown>, d: FlowDeps): Promise<{ status: number; text: string; verdict: string }> {
  let verdict: string;
  if (d.config.family === "rest_v1" && d.rest) verdict = await classifyRestWebhook(payload, d.rest);
  else if (d.config.family === "v3_mid" && d.v3) verdict = await classifyNicepayWebhook(payload, d.v3);   // v3 웹훅은 서명이 없다 → 분류만 하고 어떤 상태도 바꾸지 않는다
  else verdict = "bad_payload";
  if (verdict === "bad_signature" || verdict === "bad_payload") return { status: verdict === "bad_signature" ? 401 : 400, text: "FAIL", verdict };
  if (verdict === "mismatch" || verdict === "confirm_needed") d.log("error", "PG_NICEPAY_WEBHOOK_NEEDS_REVIEW", { verdict });
  return { status: 200, text: "OK", verdict };
}
