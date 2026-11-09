/*
  복귀 화면(서버가 만드는 고정 HTML)의 본문·스크립트. NICEPAY 가 보낸 값·토큰·식별자를 되돌려 쓰지 않는다 — 고정 문구와, 서명 검증을 통과한 시도에서 얻은 센터/상품 UUID 만 data 속성으로 싣는다.
  버튼: 기본(스크립트 없음/저장 경로 없음) = 센터 상세(없으면 홈), 스크립트가 저장된 직전 결제 화면 경로를 같은 규칙으로 다시 검증하면 "결제 화면으로 돌아가기".
  location.replace 로 이동해 이 복귀 화면이 히스토리에 남지 않게 한다. NICEPAY 를 다시 호출하지 않는다.
*/
import { createHash } from "node:crypto";
import { REVIEW_RETURN_KEYS, REVIEW_RETURN_STORAGE_KEY, REVIEW_RETURN_TTL_MS } from "../../reviewReturnPath";

export type ReturnOutcome = "closed" | "verified-not-approved" | "invalid" | undefined;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// reviewReturnPath.ts 의 sanitizeCheckoutReturnPath 와 같은 규칙(테스트가 두 구현의 결과를 대조한다).
export const RETURN_SCRIPT = `(function(){try{
var KEY=${JSON.stringify(REVIEW_RETURN_STORAGE_KEY)},TTL=${REVIEW_RETURN_TTL_MS},ALLOW=${JSON.stringify(REVIEW_RETURN_KEYS)};
var UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
var R={center:UUID,product:UUID,count:/^\\d{1,3}$/,size:/^[^\\s<>"'\`\\\\&#%]{1,40}$/,day:/^[0-6]$/,time:/^\\d{2}:\\d{2}$/,reserveClassId:UUID,reserveCenter:UUID,reserveDate:/^\\d{4}-\\d{2}-\\d{2}$/,productIds:/^[0-9a-f,-]{1,400}$/i,showAll:/^1$/};
function clean(raw){if(typeof raw!=="string"||!raw||raw.length>900||raw.indexOf("/checkout")!==0)return null;if(/[\\u0000-\\u001f\\u007f\\\\]/.test(raw)||raw.indexOf("//")>=0)return null;
var u;try{u=new URL(raw,"https://app.invalid")}catch(e){return null}
if(u.origin!=="https://app.invalid"||u.pathname!=="/checkout"||u.hash)return null;var out=new URLSearchParams(),seen={},bad=false;
u.searchParams.forEach(function(v,k){if(bad)return;if(seen[k]||ALLOW.indexOf(k)<0||!R[k].test(v)){bad=true;return}seen[k]=1;out.set(k,v)});
if(bad||!out.get("center")||!out.get("product"))return null;return "/checkout?"+out.toString()}
var a=document.getElementById("back");if(!a)return;var raw=localStorage.getItem(KEY);if(!raw)return;var v=JSON.parse(raw);
var now=Date.now();if(typeof v.at!=="number"||now-v.at<0||now-v.at>TTL)return;var p=clean(v.p);if(!p)return;
var q=new URL(p,"https://app.invalid").searchParams,ep=a.getAttribute("data-product"),ec=a.getAttribute("data-center");
if(ep&&q.get("product")!==ep)return;if(ec&&q.get("center")!==ec)return;
a.setAttribute("href",p);a.textContent="결제 화면으로 돌아가기";
a.addEventListener("click",function(e){e.preventDefault();location.replace(p)});
}catch(e){}})();`;

export const returnScriptHash = (): string => createHash("sha256").update(RETURN_SCRIPT, "utf8").digest("base64");

const COPY: Record<string, { title: string; body: string }> = {
  closed: { title: "테스트 결제창 종료", body: "결제창을 닫았어요. 결제는 진행되지 않았고 주문·이용권도 만들어지지 않았어요." },
  "verified-not-approved": { title: "인증 결과 확인 · 승인 안 함", body: "인증 결과만 확인했어요. 승인(결제)은 진행하지 않았고 주문·이용권도 만들어지지 않았어요." },
  invalid: { title: "테스트 복귀 정보 확인 불가", body: "복귀 정보를 확인할 수 없어요. 결제는 진행되지 않았어요." },
};
export function reviewReturnHtml(outcome: ReturnOutcome, ctx: { center?: string; product?: string } = {}): string {
  const c = COPY[outcome ?? "invalid"] ?? COPY.invalid;
  const center = ctx.center && UUID.test(ctx.center) ? ctx.center : null, product = ctx.product && UUID.test(ctx.product) ? ctx.product : null;
  const fallbackHref = center ? `/center/${center}` : "/", fallbackLabel = center ? "센터 화면으로 돌아가기" : "홈으로 돌아가기";
  const attrs = `${center ? ` data-center="${center}"` : ""}${product ? ` data-product="${product}"` : ""}`;
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="robots" content="noindex,nofollow"><title>${c.title}</title><style>body{font:17px/1.7 system-ui,sans-serif;margin:0;background:#fbfbfa;color:#202124}main{max-width:440px;margin:12vh auto;padding:24px}h1{font-size:25px;line-height:1.4}a{display:block;margin-top:28px;padding:12px;min-height:44px;box-sizing:border-box;text-align:center;border-radius:12px;background:#0a2446;color:white;text-decoration:none}@media(prefers-color-scheme:dark){body{background:#17181c;color:#f5f5f5}a{background:#3e7bc4}}</style></head><body><main><p>모하빗 · NICEPAY 결제창 확인</p><h1>${c.title}</h1><p>${c.body}</p><p>카드번호와 카드 인증정보를 입력하지 마세요. 이 화면은 실제 결제 완료 화면이 아닙니다.</p><a id="back" href="${fallbackHref}"${attrs}>${fallbackLabel}</a></main><script>${RETURN_SCRIPT}</script></body></html>`;
}
