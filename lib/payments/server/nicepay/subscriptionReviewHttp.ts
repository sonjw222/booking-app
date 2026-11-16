import { SUBSCRIPTION_REVIEW_PAGE } from "../../nicepaySubscriptionReviewProtocol";
import type { RegistrationOutcome } from "./subscriptionReview";

export const PRIVATE_REVIEW_HEADERS = {
  "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "X-Robots-Tag": "noindex, nofollow",
};
export const reviewJson = (body: unknown, status = 200) => Response.json(body, { status, headers: PRIVATE_REVIEW_HEADERS });
/** Read a bounded stream; Content-Length alone is insufficient for chunked/untrusted bodies. */
export async function readReviewBody(request: Request, maxBytes: number): Promise<string | null> {
  const length = request.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > maxBytes)) return null;
  const reader = request.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0, result = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) { await reader.cancel(); return null; }
      result += decoder.decode(value, { stream: true });
    }
    return result + decoder.decode();
  } catch { return null; }
  finally { reader.releaseLock(); }
}
// Render fixed messages directly from the verified POST; no result token/PG field is echoed.
export function registrationResult(outcome: RegistrationOutcome | "disabled" | "closed"): Response {
  const title = outcome === "auth-verified-no-bid" ? "인증 결과 확인 · 카드 미등록" : outcome === "closed" ? "카드 등록 심사용 확인 종료" : outcome === "disabled" ? "카드 등록 심사용 확인 준비 중" : "인증 결과를 확인할 수 없어요";
  const description = outcome === "auth-verified-no-bid" ? "인증 응답만 검증했습니다. 빌링키(BID)를 발급하거나 저장하지 않았습니다." : "심사용 확인 단계입니다. 카드번호와 카드 인증정보를 입력하지 마세요.";
  const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>${title}</title><style>body{font:17px/1.7 system-ui,sans-serif;margin:0;background:#fbfbfa;color:#202124}main{max-width:440px;margin:10vh auto;padding:24px;padding-top:max(24px,env(safe-area-inset-top))}h1{font-size:25px;line-height:1.4}a{display:block;margin-top:28px;padding:12px;text-align:center;border:1px solid currentColor;border-radius:12px;color:inherit;text-decoration:none}</style></head><body><main><p>모하빗 · NICEPAY</p><h1>${title}</h1><p>${description}</p><p>월 39,000원 정기구독 상품의 확인 화면입니다. 최초 결제와 정기 청구는 비활성 상태입니다. 카드등록·구독 시작·결제 완료를 의미하지 않습니다.</p><a target="_top" href="${SUBSCRIPTION_REVIEW_PAGE}">심사용 확인 화면으로 돌아가기</a><a target="_top" href="/manager/subscription">플랫폼 구독으로 돌아가기</a></main></body></html>`;
  return new Response(html, { status: outcome === "invalid" || outcome === "authentication-failed" ? 400 : outcome === "disabled" ? 503 : 200, headers: { ...PRIVATE_REVIEW_HEADERS, "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'self' https://pg-web.nicepay.co.kr https://dc1-web.nicepay.co.kr; form-action 'none'" } });
}
