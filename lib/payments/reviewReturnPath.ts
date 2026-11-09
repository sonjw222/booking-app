/*
  NICEPAY 결제창(심사 인증창 확인)을 닫고 돌아올 때 "바로 직전의 모하빗 결제 화면"으로 되돌아가기 위한 경로 규칙.
  - 결제창을 열기 직전에 클라이언트가 현재 결제 화면 경로(/checkout?…)를 localStorage 에 잠시 저장하고, 복귀 화면(서버가 만드는 고정 HTML)의 작은 스크립트가 같은 규칙으로 다시 검증해 버튼 목적지로만 쓴다.
  - 서명 토큰(rt)에 넣지 않는다: NICEPAY ReturnURL 은 500 바이트 제한이라 토큰이 길어지면 안 된다.
  - 검증은 허용 목록 방식이다: 같은 출처의 /checkout 경로, 허용된 쿼리 키만(센터·상품·구매 옵션·예약 진입 정보·허용 필터), 값 형식 제한. 그 밖의 키(returnToken·authKey·paymentDone 등)와 결제 상태는 버린다.
  - 결제창을 닫았다는 사실은 결제 성공이 아니다 — 이 경로 이동은 주문·결제·수강권을 만들지 않고 NICEPAY 를 다시 부르지도 않는다(결제 화면은 사용자가 다시 눌러야 연다).
*/
export const REVIEW_RETURN_STORAGE_KEY = "mwhabit.nicepayReviewReturn";
export const REVIEW_RETURN_TTL_MS = 30 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALUE_RULES: Record<string, RegExp> = {
  center: UUID, product: UUID, count: /^\d{1,3}$/, size: /^[^\s<>"'`\\&#%]{1,40}$/, day: /^[0-6]$/, time: /^\d{2}:\d{2}$/,
  reserveClassId: UUID, reserveCenter: UUID, reserveDate: /^\d{4}-\d{2}-\d{2}$/, productIds: /^[0-9a-f,-]{1,400}$/i, showAll: /^1$/,
};
export const REVIEW_RETURN_KEYS = Object.keys(VALUE_RULES);

/** 허용된 /checkout 경로면 정규화한 경로를, 아니면 null. */
export function sanitizeCheckoutReturnPath(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 900 || !raw.startsWith("/checkout")) return null;
  if (/[\u0000-\u001f\u007f\\]/.test(raw) || raw.includes("//")) return null;
  let u: URL; try { u = new URL(raw, "https://app.invalid"); } catch { return null; }
  if (u.origin !== "https://app.invalid" || u.pathname !== "/checkout" || u.hash) return null;
  const out = new URLSearchParams(); const seen = new Set<string>();
  for (const [k, v] of u.searchParams) {
    if (seen.has(k) || !(k in VALUE_RULES) || !VALUE_RULES[k].test(v)) return null;   // 모르는 키·중복·형식 오류는 전체 거부(일부만 살리지 않는다)
    seen.add(k); out.set(k, v);
  }
  if (!out.get("center") || !out.get("product")) return null;
  return `/checkout?${out.toString()}`;
}

/** 저장 값(JSON)을 검증해 복귀 경로를 돌려준다. expectProduct/expectCenter 가 있으면 일치해야 한다(다른 상품의 오래된 값 방지). */
export function readStoredReturnPath(rawJson: string | null, now: number, expect: { product?: string; center?: string } = {}): string | null {
  if (!rawJson) return null;
  try {
    const v = JSON.parse(rawJson) as { p?: unknown; at?: unknown };
    if (typeof v.at !== "number" || now - v.at < 0 || now - v.at > REVIEW_RETURN_TTL_MS) return null;
    const path = sanitizeCheckoutReturnPath(v.p); if (!path) return null;
    const q = new URL(path, "https://app.invalid").searchParams;
    if (expect.product && q.get("product") !== expect.product) return null;
    if (expect.center && q.get("center") !== expect.center) return null;
    return path;
  } catch { return null; }
}

/** 결제창을 열기 직전에 호출 — 현재 결제 화면 경로를 검증해 저장한다(실패해도 결제창 열기는 막지 않는다). */
export function rememberCheckoutReturn(loc: { pathname: string; search: string }, storage: Pick<Storage, "setItem">, now = Date.now()): boolean {
  const path = sanitizeCheckoutReturnPath(loc.pathname + loc.search); if (!path) return false;
  try { storage.setItem(REVIEW_RETURN_STORAGE_KEY, JSON.stringify({ p: path, at: now })); return true; } catch { return false; }
}
