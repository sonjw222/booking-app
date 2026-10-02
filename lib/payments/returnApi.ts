/*
  외부 Safari 복귀 콜백(app/checkout/success|fail)이 쓰는 클라이언트 호출 모음 — Supabase 세션/클라이언트에 의존하지 않는다.
  서명된 return token(Supabase 로그인 토큰이 아님)만 서버 복귀 전용 라우트로 보낸다. 토큰/결제키는 화면·로그에 노출하지 않는다.
*/
export type ReturnResult = { ok: boolean; status: number; error?: string; alreadyDone?: boolean };

async function post(path: string, body: Record<string, unknown>): Promise<ReturnResult> {
  try {
    const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), referrerPolicy: "no-referrer" });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, error: data?.error, alreadyDone: !!data?.already_done };
  } catch {
    return { ok: false, status: 0, error: "네트워크 오류로 결제 결과를 확인하지 못했어요" };
  }
}

export const returnConfirm = (p: { returnToken: string; paymentKey: string; orderId: string; amount: number }) => post("/api/payments/return/confirm", p);
export const returnCancel = (p: { returnToken: string; orderId: string }) => post("/api/payments/return/cancel", p);

// 처리 직후 주소창에서 민감한 쿼리(returnToken/paymentKey 등)를 제거한다(뒤로가기/공유로 새지 않게).
export function scrubCallbackUrl(): void {
  try { window.history.replaceState(null, "", window.location.pathname); } catch { /* 무시 */ }
}

// 앱 WebView 쪽 pending PG 주문 표시(orderId + 최소 UI 컨텍스트만 — 토큰/결제키 저장 금지)
export const PENDING_PG_ORDER_KEY = "mwhabit_pending_pg_order";
export type PendingPgOrder = { orderId: string; at: number };
export function savePendingPgOrder(orderId: string): void { try { sessionStorage.setItem(PENDING_PG_ORDER_KEY, JSON.stringify({ orderId, at: Date.now() } satisfies PendingPgOrder)); } catch { /* 무시 */ } }
export function clearPendingPgOrder(): void { try { sessionStorage.removeItem(PENDING_PG_ORDER_KEY); } catch { /* 무시 */ } }
export function readPendingPgOrder(maxAgeMs = 30 * 60_000): PendingPgOrder | null {
  try {
    const raw = sessionStorage.getItem(PENDING_PG_ORDER_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as PendingPgOrder;
    if (typeof p.orderId !== "string" || typeof p.at !== "number" || Date.now() - p.at > maxAgeMs) { clearPendingPgOrder(); return null; }
    return p;
  } catch { return null; }
}
