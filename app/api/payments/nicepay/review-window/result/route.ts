import { reviewWindowConfig, verifyReviewAttempt } from "../../../../../../lib/payments/server/nicepay/reviewWindow";

export async function GET(request: Request) {
  const c = reviewWindowConfig(process.env);
  const attempt = c ? verifyReviewAttempt(new URL(request.url).searchParams.get("rt"), c, Math.floor(Date.now() / 1000)) : null;
  const title = attempt?.outcome === "verified-not-approved" ? "인증 결과 확인 · 승인 안 함" : attempt?.outcome === "closed" ? "테스트 결제창 종료" : "테스트 복귀 정보 확인 불가";
  // Only fixed strings are rendered. No form data, identifiers, token or PG response is echoed.
  const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="robots" content="noindex,nofollow"><title>${title}</title><style>body{font:17px/1.7 system-ui,sans-serif;margin:0;background:#fbfbfa;color:#202124}main{max-width:440px;margin:12vh auto;padding:24px}h1{font-size:25px;line-height:1.4}a{display:block;margin-top:28px;padding:12px;text-align:center;border-radius:12px;background:#0a2446;color:white;text-decoration:none}@media(prefers-color-scheme:dark){body{background:#17181c;color:#f5f5f5}a{background:#3e7bc4}}</style></head><body><main><p>모하빗 · NICEPAY 결제창 확인</p><h1>${title}</h1><p>기존 앱의 결제창을 확인하는 테스트 화면입니다. 결제 승인과 주문·이용권 생성은 진행하지 않습니다.</p><p>카드번호와 카드 인증정보를 입력하지 마세요. 이 화면은 실제 결제 완료 화면이 아닙니다.</p><a href="/mypage">마이페이지로 돌아가기</a></main></body></html>`;
  return new Response(html, { headers: {
    "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow", "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  } });
}
