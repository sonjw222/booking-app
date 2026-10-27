/* NICEPAY 오프라인 테스트용 가짜 PG(REST v1)와 가짜 DB. 실제 NICEPAY/Supabase/네트워크를 쓰지 않는다. MID/키는 전부 테스트 값.
   가짜 DB의 규칙은 add_nicepay_provider_support_20261016.sql의 함수 의미(선점·승인 기록·확정·취소 기록·복귀·검토)를 그대로 따른다(실제 SQL은 real-pg 테스트가 검증). */
import { createHash } from "node:crypto";
import { restSign, restEdiDate, type RestCreds, type RestFetch } from "../../../lib/payments/server/nicepay/rest";
import type { RestDeps } from "../../../lib/payments/server/nicepay/restLifecycle";
import type { RefundCtx } from "../../../lib/payments/server/lifecycle";

export const CLIENT_ID = "S2_test_client_id", SECRET = "test_secret_key_not_real";
export const CREDS: RestCreds = { clientId: CLIENT_ID, secretKey: SECRET, apiBase: "https://sandbox-api.nicepay.co.kr" };
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export type PgFaults = Partial<{
  approve: "reject" | "http400" | "http500_after" | "timeout_before" | "timeout_after" | "bad_signature" | "amount_tamper" | "wrong_order" | "unreadable" | "status_ready";
  cancel: "http400" | "timeout_after" | "timeout_before" | "bad_resultcode" | "ok_but_stay_paid";
  lookup: "fail" | "bad_signature" | "unreadable";
  netcancel: "fail" | "http500";
}>;
type Tx = { orderId: string; amount: number; status: "ready" | "paid" | "cancelled"; cancelOrderId?: string };

export class FakePg {
  txs = new Map<string, Tx>();
  calls: { kind: "approve" | "cancel" | "netcancel" | "lookup" | "find"; tid?: string; orderId?: string; amount?: number; badRequest?: boolean }[] = [];
  faults: PgFaults = {};
  private seq = 0;
  count = (kind: string) => this.calls.filter((c) => c.kind === kind).length;

  /** 결제창 인증 성공(returnUrl로 오는 값)을 만든다: 서명은 문서 공식. 거래는 ready 상태로 생성. */
  authorize(orderId: string, amount: number, over: Record<string, unknown> = {}) {
    const tid = `UT${String(++this.seq).padStart(6, "0")}${sha(orderId).slice(0, 10)}`;
    const authToken = `AT_${tid}`;
    this.txs.set(tid, { orderId, amount, status: "ready" });
    return { authResultCode: "0000", authResultMsg: "인증 성공", tid, clientId: CLIENT_ID, orderId, amount: String(amount), authToken, signature: restSign.authResult({ authToken, clientId: CLIENT_ID, amount: String(amount) }, SECRET), ...over };
  }
  private resp(tid: string, tx: Tx, extra: Record<string, unknown> = {}) {
    const ediDate = restEdiDate(new Date());
    return { resultCode: "0000", resultMsg: "정상 처리되었습니다.", tid, orderId: tx.orderId, amount: tx.amount, ediDate, signature: restSign.response({ tid, amount: String(tx.amount), ediDate }, SECRET), status: tx.status, balanceAmt: tx.status === "cancelled" ? 0 : tx.amount, paidAt: "2026-10-17T12:00:00+0900", ...extra };
  }
  fetch: RestFetch = async (url, init) => {
    const u = new URL(url); const path = u.pathname;
    const body = init.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    const reply = (status: number, data: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
    if (init.headers.Authorization !== `Basic ${Buffer.from(`${CLIENT_ID}:${SECRET}`).toString("base64")}`) return reply(401, { resultCode: "A100", resultMsg: "auth" });
    const timeout = () => { throw new Error("timeout"); };
    let m: RegExpMatchArray | null;
    if (init.method === "POST" && path === "/v1/payments/netcancel") {
      const orderId = String(body.orderId);
      this.calls.push({ kind: "netcancel", orderId });
      if (body.signData !== restSign.netCancel({ orderId, ediDate: String(body.ediDate) }, SECRET)) return reply(200, { resultCode: "A001", resultMsg: "signData" });
      if (this.faults.netcancel === "fail") return reply(200, { resultCode: "A999", resultMsg: "netcancel rejected" });
      if (this.faults.netcancel === "http500") return reply(500, {});
      for (const [tid, tx] of this.txs) if (tx.orderId === orderId && tx.status === "paid") { tx.status = "cancelled"; return reply(200, this.resp(tid, tx, { cancelledTid: tid })); }
      return reply(200, { resultCode: "0000", resultMsg: "no paid tx", orderId });
    }
    if ((m = path.match(/^\/v1\/payments\/([^/]+)\/cancel$/)) && init.method === "POST") {
      const tid = decodeURIComponent(m[1]); const tx = this.txs.get(tid);
      this.calls.push({ kind: "cancel", tid, orderId: String(body.orderId) });
      if (this.faults.cancel === "timeout_before") return timeout();
      if (!tx) return reply(404, { resultCode: "A404" });
      if (body.signData !== restSign.cancel({ tid, ediDate: String(body.ediDate) }, SECRET)) return reply(200, { resultCode: "A001", resultMsg: "signData" });
      if (tx.status === "cancelled") return reply(400, { resultCode: "2013", resultMsg: "이미 취소된 거래" });   // 문서에 없는 응답 — 구현은 이 코드에 의존하지 않고 조회로 판단해야 한다
      if (this.faults.cancel === "http400") return reply(400, { resultCode: "A400" });
      if (this.faults.cancel === "bad_resultcode") return reply(200, { resultCode: "A500", resultMsg: "fail" });
      if (this.faults.cancel !== "ok_but_stay_paid") tx.status = "cancelled";
      tx.cancelOrderId = String(body.orderId);
      if (this.faults.cancel === "timeout_after") return timeout();
      return reply(200, this.resp(tid, tx, { cancelledTid: `${tid}C` }));
    }
    if (init.method === "POST" && (m = path.match(/^\/v1\/payments\/([^/]+)$/))) {
      const tid = decodeURIComponent(m[1]); const tx = this.txs.get(tid);
      this.calls.push({ kind: "approve", tid, amount: Number(body.amount) });
      if (this.faults.approve === "timeout_before") return timeout();
      if (!tx) return reply(404, { resultCode: "A404" });
      const ediDate = String(body.ediDate);
      if (body.signData !== restSign.approve({ tid, amount: String(body.amount), ediDate }, SECRET)) { this.calls.at(-1)!.badRequest = true; return reply(200, { resultCode: "A001", resultMsg: "signData" }); }
      if (Number(body.amount) !== tx.amount) { this.calls.at(-1)!.badRequest = true; return reply(200, { resultCode: "A002", resultMsg: "amount" }); }
      if (this.faults.approve === "http400") return reply(400, { resultCode: "A400" });
      if (this.faults.approve === "reject") return reply(200, { resultCode: "3011", resultMsg: "한도초과" });
      tx.status = this.faults.approve === "status_ready" ? "ready" : "paid";   // 돈이 움직인 시점(status_ready는 승인 응답이 paid가 아닌 이상 응답)
      if (this.faults.approve === "timeout_after") return timeout();
      if (this.faults.approve === "http500_after") return reply(500, {});
      if (this.faults.approve === "unreadable") return { ok: true, status: 200, json: async () => { throw new Error("bad json"); } };
      const base = this.resp(tid, { ...tx, status: this.faults.approve === "status_ready" ? "ready" : "paid" });
      if (this.faults.approve === "bad_signature") return reply(200, { ...base, signature: "0".repeat(64) });
      if (this.faults.approve === "amount_tamper") return reply(200, { ...base, amount: tx.amount - 1000 });   // 서명은 원래 금액 기준 → 서명도 불일치
      if (this.faults.approve === "wrong_order") { const other = { ...tx, orderId: "other-order" }; return reply(200, this.resp(tid, other, { status: "paid" })); }
      return reply(200, base);
    }
    if (init.method === "GET" && (m = path.match(/^\/v1\/payments\/find\/([^/]+)$/))) {
      const orderId = decodeURIComponent(m[1]); this.calls.push({ kind: "find", orderId });
      for (const [tid, tx] of this.txs) if (tx.orderId === orderId) return reply(200, this.resp(tid, tx));
      return reply(200, { resultCode: "A404", resultMsg: "not found" });
    }
    if (init.method === "GET" && (m = path.match(/^\/v1\/payments\/([^/]+)$/))) {
      const tid = decodeURIComponent(m[1]); const tx = this.txs.get(tid);
      this.calls.push({ kind: "lookup", tid });
      if (this.faults.lookup === "fail") return timeout();
      if (this.faults.lookup === "unreadable") return { ok: true, status: 200, json: async () => { throw new Error("x"); } };
      if (!tx) return reply(404, { resultCode: "A404" });
      const r = this.resp(tid, tx, tx.status === "cancelled" ? { cancelledTid: `${tid}C` } : {});
      return reply(200, this.faults.lookup === "bad_signature" ? { ...r, signature: "f".repeat(64) } : r);
    }
    return reply(404, {});
  };
}

type Order = { id: string; uid: string; status: string; amount: number; provider: string | null; claimId: string | null; tid: string | null; review: boolean };
type Approval = { orderId: string; claimId: string; tid: string; amount: number };
type Cancel = { orderId: string; pgTid: string; cancelTid: string; amount: number };
export type DbFaults = Partial<{ recordApproval: boolean; confirm: boolean; confirmOnce: boolean; recordCancel: boolean; recordCancelOnce: boolean; orderContextAfterConfirmFail: boolean; refund: boolean; refundOnce: boolean; blocked24h: boolean }>;

export class FakeDb {
  orders = new Map<string, Order>(); approvals: Approval[] = []; cancels: Cancel[] = []; memberships: { id: string; orderId: string; status: "active" | "refunded"; marker: boolean }[] = [];
  payments: { orderId: string | null; amount: number; kind: "new" | "refund" }[] = []; reviews: { orderId: string; reason: string }[] = []; releases: { orderId: string; basis: string }[] = [];
  faults: DbFaults = {}; logs: string[] = []; private n = 0; private brokenContext = false;
  addOrder(over: Partial<Order> & { id: string; uid: string }): Order { const o: Order = { status: "pending", amount: 12000, provider: "nicepay", claimId: null, tid: null, review: false, ...over }; this.orders.set(o.id, o); return o; }
  addPaidMembership(orderId: string) { const o = this.orders.get(orderId)!; o.status = "done"; o.tid = `TID_${orderId}`; this.approvals.push({ orderId, claimId: "c0", tid: o.tid, amount: o.amount }); this.payments.push({ orderId, amount: o.amount, kind: "new" }); const m = { id: `m-${orderId}`, orderId, status: "active" as const, marker: false }; this.memberships.push(m); return m; }
  get done() { return [...this.orders.values()].filter((o) => o.status === "done").length; }

  // ---- 결제(NicepayDeps의 DB 부분) ----
  orderContext = async (orderId: string) => { if (this.brokenContext) throw new Error("db down"); const o = this.orders.get(orderId); return o ? { orderId: o.id, status: o.status, amount: o.amount, provider: o.provider } : null; };
  claimOrder = async (orderId: string) => { const o = this.orders.get(orderId); if (!o || o.provider !== "nicepay" || o.status !== "pending" || o.review || o.tid) return null; o.status = "approving"; o.claimId = `claim-${++this.n}`; return o.claimId; };
  recordVerifiedApproval = async (orderId: string, claimId: string, tid: string, amount: number) => {
    if (this.faults.recordApproval) return { data: null, error: { message: "db fail" } };
    const o = this.orders.get(orderId);
    if (!o || o.status !== "approving" || o.claimId !== claimId) return { data: null, error: { message: "승인 선점이 일치하지 않아요" } };
    if (o.amount !== amount) return { data: null, error: { message: "결제 금액이 주문 금액과 일치하지 않아요" } };
    const ex = this.approvals.find((a) => a.tid === tid);
    if (ex) return ex.orderId === orderId && ex.claimId === claimId ? { data: { already_recorded: true }, error: null } : { data: null, error: { message: "이미 다른 주문/선점에 기록된 거래번호예요" } };
    this.approvals.push({ orderId, claimId, tid, amount }); return { data: { already_recorded: false }, error: null };
  };
  dbConfirm = async (orderId: string, claimId: string, tid: string, amount: number) => {
    if (this.faults.confirm || this.faults.confirmOnce) { this.faults.confirmOnce = false; if (this.faults.orderContextAfterConfirmFail) this.brokenContext = true; return { data: null, error: { message: "db confirm fail" } }; }
    const o = this.orders.get(orderId);
    if (!o) return { data: null, error: { message: "주문을 찾을 수 없어요" } };
    if (o.status === "done") return o.tid === tid ? { data: { already_done: true }, error: null } : { data: null, error: { message: "이미 다른 거래로 완료된 주문이에요" } };
    if (o.status !== "approving" || o.claimId !== claimId) return { data: null, error: { message: "승인 선점이 일치하지 않아요" } };
    if (!this.approvals.some((a) => a.orderId === orderId && a.claimId === claimId && a.tid === tid && a.amount === amount)) return { data: null, error: { message: "서버가 검증한 PG 승인 기록이 없어요" } };
    o.status = "done"; o.tid = tid; this.payments.push({ orderId, amount, kind: "new" }); this.memberships.push({ id: `m-${orderId}`, orderId, status: "active", marker: false });
    return { data: { already_done: false }, error: null };
  };
  recordPgCancel = async (orderId: string, pgTid: string, cancelTid: string, amount: number) => {
    if (this.faults.recordCancel || this.faults.recordCancelOnce) { this.faults.recordCancelOnce = false; return { data: null, error: { message: "db record fail" } }; }
    const o = this.orders.get(orderId); const a = this.approvals.find((x) => x.tid === pgTid && x.orderId === orderId);
    if (!o || !a) return { data: null, error: { message: "서버가 검증한 PG 승인 기록이 없는 거래예요" } };
    if (!((o.status === "done" && o.tid === a.tid) || (o.status === "approving" && o.claimId === a.claimId))) return { data: null, error: { message: "취소 확인을 기록할 수 없는 주문 상태예요" } };
    if (amount !== a.amount) return { data: null, error: { message: "전액 취소만 기록할 수 있어요" } };
    if (cancelTid === a.tid) return { data: null, error: { message: "취소 거래번호가 승인 거래번호와 같아요" } };
    const ex = this.cancels.find((c) => c.orderId === orderId && c.pgTid === a.tid);
    if (ex) return ex.cancelTid === cancelTid ? { data: { already_recorded: true }, error: null } : { data: null, error: { message: "이미 다른 취소 거래가 기록된 주문이에요" } };
    this.cancels.push({ orderId, pgTid: a.tid, cancelTid, amount }); return { data: { already_recorded: false }, error: null };
  };
  releaseOrder = async (orderId: string, claimId: string, basis: "approve_rejected" | "netcancel_confirmed") => {
    const o = this.orders.get(orderId);
    if (!o || o.status !== "approving" || o.claimId !== claimId || o.tid || o.review) return false;
    if (this.approvals.some((a) => a.orderId === orderId && a.claimId === claimId && !this.cancels.some((c) => c.orderId === orderId && c.pgTid === a.tid))) return false;
    o.status = "pending"; o.claimId = null; this.releases.push({ orderId, basis }); return true;
  };
  markReview = async (orderId: string, _claimId: string, reason: string) => { const o = this.orders.get(orderId); if (o) o.review = true; this.reviews.push({ orderId, reason }); };

  // ---- 소유/상태/게이트/취소(FlowDeps) ----
  gateOpen = true;
  gateAllows = async () => this.gateOpen;
  ownedOrder = async (orderId: string, uid: string) => { const o = this.orders.get(orderId); return o && o.uid === uid ? { orderId: o.id, status: o.status, amount: o.amount, provider: o.provider } : null; };
  orderState = async (orderId: string) => { const o = this.orders.get(orderId); return o ? { status: o.status, reviewPending: o.review } : null; };
  cancelPendingOrder = async (orderId: string) => { const o = this.orders.get(orderId); if (!o || o.status !== "pending") return false; o.status = "cancelled"; return true; };

  // ---- 환불 ----
  refundContext = async (membershipId: string, uid: string): Promise<RefundCtx | null> => {
    const m = this.memberships.find((x) => x.id === membershipId); const o = m && this.orders.get(m.orderId);
    if (!m || !o || o.uid !== uid) return null;
    return { membershipId, status: m.status, blockReason: null, orderId: o.id, provider: o.provider, paymentKey: o.tid, amount: o.amount, refundPending: m.marker };
  };
  refundBegin = async (membershipId: string) => { const m = this.memberships.find((x) => x.id === membershipId)!; if (m.status === "refunded") return { state: "refunded" as const }; if (m.marker) return { state: "resumed" as const }; if (this.faults.blocked24h) return { state: "blocked" as const, reason: "구매 후 24시간이 지나 환불할 수 없어요" }; m.marker = true; return { state: "locked" as const }; };
  refundRelease = async (membershipId: string) => { const m = this.memberships.find((x) => x.id === membershipId)!; m.marker = false; return { data: null, error: null }; };
  dbRefund = async (membershipId: string) => {
    if (this.faults.refund || this.faults.refundOnce) { this.faults.refundOnce = false; return { data: null, error: { message: "db refund fail" } }; }
    const m = this.memberships.find((x) => x.id === membershipId)!; const o = this.orders.get(m.orderId)!;
    if (m.status === "refunded") return { data: null, error: { message: "이미 환불된 수강권이에요" } };
    if (o.provider === "nicepay" && o.amount > 0 && !this.cancels.some((c) => c.orderId === o.id && c.amount === o.amount)) return { data: null, error: { message: "NICEPAY 결제는 PG 승인 취소가 확인된 뒤에만 환불할 수 있어요" } };
    m.status = "refunded"; m.marker = false; this.payments.push({ orderId: null, amount: -o.amount, kind: "refund" });
    return { data: { refunded: true, amount: o.amount }, error: null };
  };
}

export function makeRestDeps(db: FakeDb, pg: FakePg): RestDeps & { logs: string[] } {
  const logs: string[] = [];
  return {
    creds: CREDS, fetchImpl: pg.fetch, now: () => new Date("2026-10-17T03:00:00Z"), gateAllows: db.gateAllows, logs,
    orderContext: db.orderContext, claimOrder: db.claimOrder, releaseOrder: db.releaseOrder, markReview: db.markReview,
    recordVerifiedApproval: db.recordVerifiedApproval, recordPgCancel: db.recordPgCancel, dbConfirm: db.dbConfirm,
    log: (level, event, fields) => { logs.push(`${level} ${event} ${JSON.stringify(fields)}`); },
  };
}
