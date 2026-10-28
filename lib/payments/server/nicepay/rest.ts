/*
  NICEPAY REST(v1) 계열 서버 연동 — 공식 매뉴얼(github.com/nicepayments/nicepay-manual, api/payment-window-server.md · cancel.md · status-transaction.md · hook.md, 2026-10-17 확인)의
  "결제창 Server 승인 모델" 기준. 서명/엔드포인트는 문서에 명시된 것만 구현하고, 문서가 말하지 않는 것(취소 응답 서명 공식, 이미 취소된 거래 재요청 응답, 멱등성, ediDate 정확한 포맷)은
  추측하지 않고 "거래 조회 재확인"으로 대체한다(재확인 응답의 서명 공식은 문서에 있다). 계약 후 클라이언트 키 계열이 이 규격과 다르면(v3 MID) 이 파일은 쓰이지 않는다 — config.ts의 family로 분기.
  fetch는 호출자가 주입한다(기본값 없음) → 이 파일을 import해도 네트워크 호출이 일어나지 않고 테스트는 가짜 fetch만 쓴다.
    인증결과 signature   = hex(sha256(authToken + clientId + amount + SecretKey))
    승인 요청 signData   = hex(sha256(tid + amount + ediDate + SecretKey)),  승인/조회/웹훅 응답 signature = hex(sha256(tid + amount + ediDate + SecretKey))
    취소 요청 signData   = hex(sha256(tid + ediDate + SecretKey))
    망취소 요청 signData = hex(sha256(orderId + ediDate + SecretKey))   (요청 후 1시간 내, orderId 유일할 때만)
  인증 헤더: Authorization: Basic base64(clientId:secretKey). 연결 5초/응답 30초(문서) — fetch는 합산 30초로 제한한다.
*/
import { createHash, timingSafeEqual } from "node:crypto";
import type { NicepayResult } from "./types";

export const REST_ALLOWED_API_HOSTS = ["api.nicepay.co.kr", "sandbox-api.nicepay.co.kr"] as const;
export type RestFetch = (url: string, init: { method: "GET" | "POST"; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
export type RestCreds = { clientId: string; secretKey: string; apiBase: string };

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
export const restSign = {
  authResult: (p: { authToken: string; clientId: string; amount: string }, key: string) => sha(p.authToken + p.clientId + p.amount + key),
  approve: (p: { tid: string; amount: string; ediDate: string }, key: string) => sha(p.tid + p.amount + p.ediDate + key),
  response: (p: { tid: string; amount: string; ediDate: string }, key: string) => sha(p.tid + p.amount + p.ediDate + key),   // 승인·조회·웹훅 응답 공통(문서)
  cancel: (p: { tid: string; ediDate: string }, key: string) => sha(p.tid + p.ediDate + key),
  netCancel: (p: { orderId: string; ediDate: string }, key: string) => sha(p.orderId + p.ediDate + key),
};
export function restSignatureMatches(expectedHex: string, actual: unknown): boolean {
  if (typeof actual !== "string" || !actual || actual.length !== expectedHex.length) return false;
  return timingSafeEqual(Buffer.from(expectedHex, "utf8"), Buffer.from(actual.toLowerCase(), "utf8"));
}
/** ISO 8601 (KST 오프셋). ⚠ 문서는 "ISO 8601"만 명시 — 정확한 허용 포맷(오프셋/밀리초)은 계약 후 샌드박스 확인 필요. */
export const restEdiDate = (d: Date): string => {
  const k = new Date(d.getTime() + 9 * 3600_000);
  return `${k.toISOString().slice(0, 19)}+09:00`;
};
export const basicAuth = (c: { clientId: string; secretKey: string }) => `Basic ${Buffer.from(`${c.clientId}:${c.secretKey}`, "utf8").toString("base64")}`;

export function isAllowedRestUrl(raw: string, apiBase: string): boolean {
  try {
    const u = new URL(raw), b = new URL(apiBase);
    return u.protocol === "https:" && !u.username && !u.password && (u.port === "" || u.port === "443") && u.hostname === b.hostname && (REST_ALLOWED_API_HOSTS as readonly string[]).includes(u.hostname);
  } catch { return false; }
}

export type RestResponse = {
  resultCode?: string; resultMsg?: string; tid?: string; cancelledTid?: string; orderId?: string; ediDate?: string; signature?: string;
  status?: string; amount?: number | string; balanceAmt?: number | string; payMethod?: string; paidAt?: string; cancelledAt?: string; [k: string]: unknown;
};
export const REST_OK = "0000";

async function call(f: RestFetch, c: RestCreds, method: "GET" | "POST", path: string, body?: Record<string, unknown>): Promise<NicepayResult<RestResponse>> {
  const url = `${c.apiBase}${path}`;
  if (!isAllowedRestUrl(url, c.apiBase)) return { ok: false, status: 0, code: "URL_NOT_ALLOWED", message: "허용되지 않은 NICEPAY URL이에요" };
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 30_000);
  try {
    const res = await f(url, { method, signal: ctl.signal, headers: { Authorization: basicAuth(c), "Content-Type": "application/json;charset=utf-8" }, body: body ? JSON.stringify(body) : undefined });
    const data = (await res.json().catch(() => null)) as RestResponse | null;
    // 2xx인데 본문을 읽지 못하면 결과 불명(status 0). HTTP 오류는 확정 실패로 본다.
    if (res.ok && (!data || typeof data !== "object")) return { ok: false, status: 0, code: "UNREADABLE_RESPONSE", message: "NICEPAY 응답을 해석하지 못했어요" };
    if (!res.ok || !data) return { ok: false, status: res.status || 502, code: typeof data?.resultCode === "string" ? data.resultCode : null, message: "NICEPAY 요청이 거절됐어요" };
    return { ok: true, data };
  } catch (e) {
    return { ok: false, status: 0, code: "NETWORK_ERROR", message: e instanceof Error ? e.message : "NICEPAY 요청 중 네트워크 오류" };
  } finally { clearTimeout(timer); }
}

const amtStr = (n: number) => { if (!Number.isSafeInteger(n) || n <= 0) throw new Error("결제 금액이 올바르지 않아요"); return String(n); };
export const parseRestAmount = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d{1,12}$/.test(v) ? Number(v) : NaN;
  return Number.isSafeInteger(n) ? n : null;
};

/** 승인(돈이 움직이는 호출). amount는 항상 서버가 DB 주문에서 읽은 값. */
export function restApprove(f: RestFetch, c: RestCreds, p: { tid: string; amount: number; now: Date }) {
  const amount = amtStr(p.amount), ediDate = restEdiDate(p.now);
  return call(f, c, "POST", `/v1/payments/${encodeURIComponent(p.tid)}`, { amount: p.amount, ediDate, signData: restSign.approve({ tid: p.tid, amount, ediDate }, c.secretKey), returnCharSet: "utf-8" });
}
/** 망취소(승인 응답 유실·타임아웃). orderId는 이 거래의 가맹점 주문번호(유일해야 정상 처리 — 문서). */
export function restNetCancel(f: RestFetch, c: RestCreds, p: { orderId: string; now: Date }) {
  const ediDate = restEdiDate(p.now);
  return call(f, c, "POST", "/v1/payments/netcancel", { orderId: p.orderId, ediDate, signData: restSign.netCancel({ orderId: p.orderId, ediDate }, c.secretKey), returnCharSet: "utf-8" });
}
/** 승인 후 전액 취소. cancelOrderId는 취소 요청용 가맹점 번호(재요청 때 같은 값을 쓴다 — 결정적). 부분취소는 구현하지 않는다(cancelAmt 생략 = 전액). */
export function restCancel(f: RestFetch, c: RestCreds, p: { tid: string; cancelOrderId: string; reason: string; now: Date }) {
  const ediDate = restEdiDate(p.now);
  return call(f, c, "POST", `/v1/payments/${encodeURIComponent(p.tid)}/cancel`, { reason: p.reason.slice(0, 100), orderId: p.cancelOrderId, ediDate, signData: restSign.cancel({ tid: p.tid, ediDate }, c.secretKey), returnCharSet: "utf-8" });
}
/** 거래 상태 조회(tid). 응답 signature = 문서 공식. 서명이 틀리면 "신뢰할 수 없는 응답"으로 취급한다. */
export function restLookup(f: RestFetch, c: RestCreds, p: { tid: string; now: Date }) {
  const ediDate = restEdiDate(p.now);
  const qs = new URLSearchParams({ ediDate, signData: sha(p.tid + ediDate + c.secretKey), returnCharSet: "utf-8" });
  return call(f, c, "GET", `/v1/payments/${encodeURIComponent(p.tid)}?${qs.toString()}`);
}

/** 조회/승인 응답이 "서명·거래번호·주문번호·금액"까지 모두 맞는지. 하나라도 틀리면 false — 호출자는 성공으로 취급하지 않는다. */
export function verifyRestResponse(r: RestResponse, c: RestCreds, expect: { tid: string; orderId?: string; amount?: number }): boolean {
  const amt = parseRestAmount(r.amount);
  if (typeof r.tid !== "string" || r.tid !== expect.tid || amt === null || typeof r.ediDate !== "string") return false;
  if (!restSignatureMatches(restSign.response({ tid: r.tid, amount: String(amt), ediDate: r.ediDate }, c.secretKey), r.signature)) return false;
  if (expect.orderId !== undefined && r.orderId !== expect.orderId) return false;
  if (expect.amount !== undefined && amt !== expect.amount) return false;
  return true;
}

/** 주문번호 조회(문서: GET /v1/payments/find/{orderId}, orderDate=YYYYMMDD 필수). 결제창 후 tid를 모르는 승인 진행/유실 건의 복구 조사용 — 읽기 전용. */
export function restLookupByOrderId(f: RestFetch, c: RestCreds, p: { orderId: string; orderDate: string; now: Date }) {
  if (!/^\d{8}$/.test(p.orderDate)) throw new Error("orderDate 형식이 올바르지 않아요");
  const qs = new URLSearchParams({ orderDate: p.orderDate, ediDate: restEdiDate(p.now), returnCharSet: "utf-8" });
  return call(f, c, "GET", `/v1/payments/find/${encodeURIComponent(p.orderId)}?${qs.toString()}`);
}
