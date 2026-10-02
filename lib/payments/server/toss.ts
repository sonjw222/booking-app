/*
  토스페이먼츠 서버-서버 API 호출(시크릿 키는 서버 라우트가 환경변수에서 읽어 인자로 넘긴다 — 이 파일은 키를 저장/로그하지 않는다).
  fetch는 인자로 주입할 수 있어 테스트에서 실제 토스를 호출하지 않는다.
  네트워크 오류/타임아웃은 status 0("결과를 알 수 없음")으로 구분한다 — 승인 요청에서는 돈이 움직였는지 모른다는 뜻이다.
*/

export type TossResult =
  | { ok: true; data: any }
  | { ok: false; status: number; code: string | null; message: string };

type FetchLike = typeof fetch;
const BASE = "https://api.tosspayments.com/v1";

function authHeader(secretKey: string): string {
  return "Basic " + Buffer.from(`${secretKey}:`).toString("base64");
}

async function call(secretKey: string, method: "GET" | "POST", path: string, body: unknown, idempotencyKey: string | undefined, fetchImpl: FetchLike): Promise<TossResult> {
  try {
    const res = await fetchImpl(`${BASE}${path}`, {
      method,
      headers: {
        Authorization: authHeader(secretKey),
        "Content-Type": "application/json",
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, status: res.status, code: typeof data?.code === "string" ? data.code : null, message: data?.message ?? "토스 요청에 실패했어요" };
    }
    return { ok: true, data };
  } catch (e) {
    return { ok: false, status: 0, code: "NETWORK_ERROR", message: e instanceof Error ? e.message : "토스 요청 중 네트워크 오류" };
  }
}

// 결제 승인 — 돈이 실제로 움직이는 호출. amount는 항상 서버가 DB 주문에서 읽은 값을 쓴다.
export function tossConfirmPayment(secretKey: string, p: { paymentKey: string; orderId: string; amount: number; idempotencyKey?: string }, fetchImpl: FetchLike = fetch): Promise<TossResult> {
  return call(secretKey, "POST", "/payments/confirm", { paymentKey: p.paymentKey, orderId: p.orderId, amount: p.amount }, p.idempotencyKey, fetchImpl);
}

// 승인 취소(전액) — cancelAmount를 생략하면 전액 취소다. 같은 Idempotency-Key로 재시도해도 이중 취소되지 않는다.
export function tossCancelPayment(secretKey: string, paymentKey: string, p: { cancelReason: string; idempotencyKey?: string }, fetchImpl: FetchLike = fetch): Promise<TossResult> {
  return call(secretKey, "POST", `/payments/${encodeURIComponent(paymentKey)}/cancel`, { cancelReason: p.cancelReason }, p.idempotencyKey, fetchImpl);
}

// 결제 조회 — 승인/취소 결과가 불확실할 때 실제 상태(DONE/CANCELED 등)를 확인한다.
export function tossGetPayment(secretKey: string, paymentKey: string, fetchImpl: FetchLike = fetch): Promise<TossResult> {
  return call(secretKey, "GET", `/payments/${encodeURIComponent(paymentKey)}`, undefined, undefined, fetchImpl);
}
