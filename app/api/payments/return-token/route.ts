/*
  결제 시작 시 복귀 토큰 발급 — 앱 WebView의 로그인 세션(Bearer)으로만 호출 가능. 본인 + toss + pending 주문 + PG 게이트 허용일 때만 발급한다.
  발급되는 것은 Supabase 로그인 토큰이 아니라 "이 주문의 복귀 처리"만 허용하는 서명 토큰이다(lib/payments/server/returnToken.ts).
*/
import { buildDeps, bearerToken, createAdminClient } from "../../../../lib/payments/server/deps";
import { checkReturnTokenEligibility } from "../../../../lib/payments/server/lifecycle";
import { mintReturnToken } from "../../../../lib/payments/server/returnToken";

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function POST(request: Request) {
  const secret = process.env.PAYMENT_RETURN_TOKEN_SECRET;
  if (!secret) return json({ error: "결제 서버 설정이 없어요(PAYMENT_RETURN_TOKEN_SECRET)" }, 500);
  const admin = createAdminClient();
  if (!admin) return json({ error: "결제 서버 설정이 없어요(SUPABASE_SERVICE_ROLE_KEY)" }, 500);
  let body: { orderId?: unknown };
  try { body = await request.json(); } catch { return json({ error: "요청 형식이 올바르지 않아요" }, 400); }
  const el = await checkReturnTokenEligibility({ token: bearerToken(request), orderId: body.orderId }, buildDeps(admin, ""));
  if (!el.ok) return json(el.reply.body, el.reply.status);
  return json({ ok: true, returnToken: mintReturnToken(secret, { orderId: el.orderId, uid: el.uid }) });
}
