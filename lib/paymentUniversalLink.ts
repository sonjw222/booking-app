/*
  iOS Universal Link(결제 복귀) 라우팅 — 순수 helper.
  토스 successUrl/failUrl(https://mwhabit.com/checkout/success|fail?...)이 Universal Link로 앱에 전달되면, 앱 WebView 안에서
  같은 경로를 열어 기존 콜백 페이지(app/checkout/success|fail)를 그대로 실행한다. 승인/취소 로직은 새로 만들지 않는다.
  허용: https + origin이 정확히 https://mwhabit.com + pathname이 정확히 두 경로. 그 외는 모두 무시(임의 URL을 window.location에 넣지 않는다).
  URL/쿼리(paymentKey, returnToken)는 저장하지 않고 로그하지 않는다 — 이 파일에는 로깅/저장 코드가 없다.
*/
export const PAYMENT_LINK_ORIGIN = "https://mwhabit.com";
export const PAYMENT_LINK_PATHS = ["/checkout/success", "/checkout/fail"] as const;

// 허용된 결제 콜백 URL이면 앱 내부 이동 대상("/checkout/success?..." = pathname + search)을, 아니면 null.
export function resolvePaymentCallbackTarget(rawUrl: unknown): string | null {
  if (typeof rawUrl !== "string" || !rawUrl) return null;
  let u: URL;
  try { u = new URL(rawUrl); } catch { return null; }
  if (u.protocol !== "https:" || u.origin !== PAYMENT_LINK_ORIGIN) return null;
  if (u.username || u.password) return null;
  if (!(PAYMENT_LINK_PATHS as readonly string[]).includes(u.pathname)) return null;
  return u.pathname + u.search;   // hash는 버린다
}

// 콜드 스타트 getLaunchUrl은 WebView 풀 리로드마다 같은 값을 다시 돌려줄 수 있으므로, 세션당 한 번만 확인한다(값이 아닌 boolean 표시만 사용).
export const LAUNCH_CHECK_FLAG = "mwhabit_ul_launch_checked";
export function shouldCheckLaunchUrl(storage: Pick<Storage, "getItem" | "setItem"> | null): boolean {
  try {
    if (!storage) return true;
    if (storage.getItem(LAUNCH_CHECK_FLAG) === "1") return false;
    storage.setItem(LAUNCH_CHECK_FLAG, "1");
    return true;
  } catch { return true; }
}
