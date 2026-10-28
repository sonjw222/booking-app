/*
  NICEPAY 서버-서버 호출(승인 / 망취소 / 승인취소) — ⚠ 아직 어떤 라우트에도 연결되지 않았다(활성화 금지, MID/KEY 계약 후 별도 승인).
  fetch는 호출자가 반드시 주입한다(기본값 없음) → 이 파일을 import하는 것만으로는 네트워크 호출이 일어나지 않고, 테스트는 가짜 fetch만 쓴다.
  URL은 NICEPAY가 인증결과로 내려준 NextAppURL/NetCancelURL을 쓰되, 허용 호스트(isAllowedNicepayUrl)가 아니면 요청 전에 거부한다.
  네트워크 오류/타임아웃은 status 0 = "결과를 알 수 없음"(승인 요청이면 돈이 움직였는지 모른다 → 호출자는 망취소를 시도해야 한다).
  요청은 CharSet=utf-8, EdiType=JSON으로 고정한다(문서 기본값 EUC-KR). 문서의 연결 5초·응답 30초 타임아웃을 적용한다.
*/
import { amtString } from "./signature";
import { nicepaySign } from "./signature";
import {
  isAllowedNicepayUrl, NICEPAY_APPROVE_OK_CARD, NICEPAY_CANCEL_OK,
  type NicepayApproveResponse, type NicepayCancelResponse, type NicepayResult,
} from "./types";

export type NicepayFetch = (url: string, init: { method: "POST"; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
export type NicepayCreds = { mid: string; merchantKey: string };
const TIMEOUT_MS = 30_000;

export const ediDateOf = (d: Date): string => {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  const k = new Date(d.getTime() + 9 * 3600_000); // KST
  return `${k.getUTCFullYear()}${p(k.getUTCMonth() + 1)}${p(k.getUTCDate())}${p(k.getUTCHours())}${p(k.getUTCMinutes())}${p(k.getUTCSeconds())}`;
};

async function post<T>(fetchImpl: NicepayFetch, url: string, form: Record<string, string>): Promise<NicepayResult<T>> {
  if (!isAllowedNicepayUrl(url)) return { ok: false, status: 0, code: "URL_NOT_ALLOWED", message: "허용되지 않은 NICEPAY URL이에요" };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      method: "POST", signal: ctl.signal,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...form, CharSet: "utf-8", EdiType: "JSON" }).toString(),
    });
    const data = (await res.json().catch(() => null)) as T | null;
    // 2xx인데 본문을 해석하지 못하면 승인 여부를 알 수 없다 → status 0(= 결과 불명, 호출자는 망취소). HTTP 오류 응답만 확정 실패로 본다.
    if (res.ok && (!data || typeof data !== "object")) return { ok: false, status: 0, code: "UNREADABLE_RESPONSE", message: "NICEPAY 응답을 해석하지 못했어요" };
    if (!res.ok || !data) return { ok: false, status: res.status || 502, code: null, message: "NICEPAY 요청이 거절됐어요" };
    return { ok: true, data };
  } catch (e) {
    return { ok: false, status: 0, code: "NETWORK_ERROR", message: e instanceof Error ? e.message : "NICEPAY 요청 중 네트워크 오류" };
  } finally { clearTimeout(timer); }
}

// 승인 — 돈이 움직이는 호출. amount는 항상 서버가 DB 주문에서 읽은 값.
export function nicepayApprove(fetchImpl: NicepayFetch, c: NicepayCreds, p: { nextAppUrl: string; tid: string; authToken: string; amount: number; now: Date }) {
  const amt = amtString(p.amount); const ediDate = ediDateOf(p.now);
  return post<NicepayApproveResponse>(fetchImpl, p.nextAppUrl, {
    TID: p.tid, AuthToken: p.authToken, MID: c.mid, Amt: amt, EdiDate: ediDate,
    SignData: nicepaySign.approveRequest({ authToken: p.authToken, mid: c.mid, amt, ediDate }, c.merchantKey),
  });
}

// 망취소 — 승인 응답을 못 받았거나 서버가 처리하지 못했을 때 거래 불일치를 막는다(성공 2001).
export async function nicepayNetCancel(fetchImpl: NicepayFetch, c: NicepayCreds, p: { netCancelUrl: string; tid: string; authToken: string; amount: number; now: Date }): Promise<NicepayResult<NicepayCancelResponse>> {
  const amt = amtString(p.amount); const ediDate = ediDateOf(p.now);
  const r = await post<NicepayCancelResponse>(fetchImpl, p.netCancelUrl, {
    TID: p.tid, AuthToken: p.authToken, MID: c.mid, Amt: amt, EdiDate: ediDate, NetCancel: "1",
    SignData: nicepaySign.netCancelRequest({ authToken: p.authToken, mid: c.mid, amt, ediDate }, c.merchantKey),
  });
  if (r.ok && !NICEPAY_CANCEL_OK.includes(String(r.data.ResultCode))) return { ok: false, status: 400, code: String(r.data.ErrorCD ?? r.data.ResultCode ?? ""), message: "망취소가 거절됐어요" };
  return r;
}

// 승인 후 취소(전액만 이번 범위). cancelMoid는 취소 요청마다 유일해야 한다(문서). 부분취소는 구현하지 않는다.
export async function nicepayCancel(fetchImpl: NicepayFetch, c: NicepayCreds, p: { cancelUrl: string; tid: string; cancelMoid: string; amount: number; reason: string; now: Date }): Promise<NicepayResult<NicepayCancelResponse>> {
  const amt = amtString(p.amount); const ediDate = ediDateOf(p.now);
  const r = await post<NicepayCancelResponse>(fetchImpl, p.cancelUrl, {
    TID: p.tid, MID: c.mid, Moid: p.cancelMoid, CancelAmt: amt, CancelMsg: p.reason.slice(0, 100), PartialCancelCode: "0", EdiDate: ediDate,
    SignData: nicepaySign.cancelRequest({ mid: c.mid, cancelAmt: amt, ediDate }, c.merchantKey),
  });
  if (r.ok && !NICEPAY_CANCEL_OK.includes(String(r.data.ResultCode))) return { ok: false, status: 400, code: String(r.data.ErrorCD ?? r.data.ResultCode ?? ""), message: "취소가 거절됐어요" };
  return r;
}

export { NICEPAY_APPROVE_OK_CARD };
