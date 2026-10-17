/* NICEPAY 결제 결과 화면/Provider가 쓰는 클라이언트 호출 — 서버 라우트(app/api/payments/nicepay/*)만 부른다. 키/서명은 브라우저에 없다. */
export type NicepayUiState = "done" | "cancelled" | "review" | "processing" | "pending" | "unknown";
export type StatusResult = { ok: boolean; status: number; state: NicepayUiState; final: boolean; error?: string };

async function post(path: string, body: Record<string, unknown>, bearer?: string | null): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  try {
    const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json", ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) }, body: JSON.stringify(body), referrerPolicy: "no-referrer" });
    return { ok: res.ok, status: res.status, data: ((await res.json().catch(() => ({}))) ?? {}) as Record<string, unknown> };
  } catch { return { ok: false, status: 0, data: {} }; }
}

export async function fetchNicepayStatus(p: { orderId: string; returnToken?: string | null; bearer?: string | null }): Promise<StatusResult> {
  const r = await post("/api/payments/nicepay/status", { orderId: p.orderId, returnToken: p.returnToken ?? undefined }, p.bearer);
  const state = (typeof r.data.state === "string" ? r.data.state : "unknown") as NicepayUiState;
  return { ok: r.ok, status: r.status, state: r.ok ? state : "unknown", final: r.ok && r.data.final === true, error: typeof r.data.error === "string" ? r.data.error : undefined };
}
/** 성공은 서버(DB)가 done이라고 한 경우에만. 처리 중이면 간격을 두고 다시 묻는다(무한 폴링 없음). */
export async function pollNicepayStatus(p: { orderId: string; returnToken?: string | null; bearer?: string | null }, opts: { attempts?: number; delayMs?: number; fetchStatus?: typeof fetchNicepayStatus } = {}): Promise<StatusResult> {
  const fetchStatus = opts.fetchStatus ?? fetchNicepayStatus, attempts = opts.attempts ?? 12, delay = opts.delayMs ?? 2500;
  let r = await fetchStatus(p);
  for (let i = 1; i < attempts && r.ok && !r.final && (r.state === "processing" || r.state === "pending"); i++) {
    await new Promise((res) => setTimeout(res, delay));
    r = await fetchStatus(p);
  }
  return r;
}
export const abandonNicepayOrder = (p: { orderId: string; returnToken?: string | null; bearer?: string | null }) => post("/api/payments/nicepay/abandon", { orderId: p.orderId, returnToken: p.returnToken ?? undefined }, p.bearer);
export const prepareNicepay = (p: { orderId: string; orderName?: string; bearer: string }) => post("/api/payments/nicepay/prepare", { orderId: p.orderId, orderName: p.orderName }, p.bearer);
