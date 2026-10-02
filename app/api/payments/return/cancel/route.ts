/*
  외부 Safari 복귀 전용 승인 전 주문 취소(failUrl) — 서명된 return token 검증 후 기존 cancel core 실행(pending 주문만, 토스 취소 API 호출 없음).
*/
import { buildDeps, createAdminClient } from "../../../../../lib/payments/server/deps";
import { cancelForAuthorizedUid } from "../../../../../lib/payments/server/lifecycle";
import { verifyReturnToken } from "../../../../../lib/payments/server/returnToken";

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });

export async function POST(request: Request) {
  let body: { returnToken?: unknown; orderId?: unknown };
  try { body = await request.json(); } catch { return json({ error: "요청 형식이 올바르지 않아요" }, 400); }
  const v = verifyReturnToken(process.env.PAYMENT_RETURN_TOKEN_SECRET, body.returnToken, body.orderId);
  if (!v.ok) return json({ error: v.reason === "no_secret" ? "결제 서버 설정이 없어요(PAYMENT_RETURN_TOKEN_SECRET)" : "결제 확인 정보가 올바르지 않거나 만료됐어요", code: "invalid_return_token" }, v.reason === "no_secret" ? 500 : 401);
  const admin = createAdminClient();
  if (!admin) return json({ error: "결제 서버 설정이 없어요(SUPABASE_SERVICE_ROLE_KEY)" }, 500);
  const reply = await cancelForAuthorizedUid(v.uid, v.orderId, buildDeps(admin, ""));
  return json(reply.body, reply.status);
}
