/*
  외부 Safari 복귀 전용 결제 승인 — Supabase 세션 없이 서명된 return token으로 uid를 얻는다. 토큰 검증 전에는 토스/DB를 절대 호출하지 않는다.
  검증 뒤에는 Bearer 경로와 같은 core(confirmForAuthorizedUid)를 실행해 모든 결제 안전 규칙을 그대로 쓴다. 기존 /api/payments/confirm의 Bearer 계약은 변경하지 않는다.
*/
import { buildDeps, createAdminClient } from "../../../../../lib/payments/server/deps";
import { confirmForAuthorizedUid } from "../../../../../lib/payments/server/lifecycle";
import { verifyReturnToken } from "../../../../../lib/payments/server/returnToken";

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });

export async function POST(request: Request) {
  let body: { returnToken?: unknown; paymentKey?: unknown; orderId?: unknown; amount?: unknown };
  try { body = await request.json(); } catch { return json({ error: "요청 형식이 올바르지 않아요" }, 400); }
  const v = verifyReturnToken(process.env.PAYMENT_RETURN_TOKEN_SECRET, body.returnToken, body.orderId);
  if (!v.ok) return json({ error: v.reason === "no_secret" ? "결제 서버 설정이 없어요(PAYMENT_RETURN_TOKEN_SECRET)" : "결제 확인 정보가 올바르지 않거나 만료됐어요. 모하빗 앱에서 구매내역을 확인해주세요", code: "invalid_return_token" }, v.reason === "no_secret" ? 500 : 401);
  const { paymentKey, amount } = body;
  if (typeof paymentKey !== "string" || !paymentKey || typeof amount !== "number") return json({ error: "paymentKey/orderId/amount가 모두 필요해요" }, 400);
  const secret = process.env.TOSS_SECRET_KEY;
  if (!secret) return json({ error: "결제 서버 설정이 없어요(TOSS_SECRET_KEY)" }, 500);
  const admin = createAdminClient();
  if (!admin) return json({ error: "결제 서버 설정이 없어요(SUPABASE_SERVICE_ROLE_KEY)" }, 500);
  const reply = await confirmForAuthorizedUid(v.uid, { paymentKey, orderId: v.orderId, amount }, buildDeps(admin, secret));
  return json(reply.body, reply.status);
}
