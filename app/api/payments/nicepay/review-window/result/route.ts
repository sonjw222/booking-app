import { reviewWindowConfig, verifyReviewAttempt } from "../../../../../../lib/payments/server/nicepay/reviewWindow";
import { returnScriptHash, reviewReturnHtml } from "../../../../../../lib/payments/server/nicepay/reviewReturnPage";

export async function GET(request: Request) {
  const c = reviewWindowConfig(process.env);
  const attempt = c ? verifyReviewAttempt(new URL(request.url).searchParams.get("rt"), c, Math.floor(Date.now() / 1000)) : null;
  // 취소(closed)·인증만 확인(verified-not-approved)·확인 불가(invalid)를 섞지 않는다. 고정 문구만 렌더하고 NICEPAY 값·토큰은 되돌려 쓰지 않는다.
  // 버튼은 직전 모하빗 결제 화면(저장된 경로를 같은 규칙으로 재검증)으로, 없으면 센터 상세로 보낸다 — NICEPAY 를 다시 호출하거나 주문·결제를 만들지 않는다.
  const html = reviewReturnHtml(attempt?.outcome ?? "invalid", { center: attempt?.center, product: attempt?.product });
  return new Response(html, { headers: {
    "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow", "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${returnScriptHash()}'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
  } });
}
