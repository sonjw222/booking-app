/*
  결제 승인(confirm) 서버 라우트.

  토스 승인 API는 시크릿 키(TOSS_SECRET_KEY)가 필요해 서버에서만 호출한다(NEXT_PUBLIC_ 접두사 없음, 브라우저 번들에 포함되지 않음).
  흐름은 lib/payments/server/lifecycle.ts handleConfirm 참고:
    로그인 검증 → 본인 주문/금액/상태/게이트 확인 → 토스 승인(DB 주문 금액) → confirm_real_payment(service_role)
    → DB 확정이 실패하면(승인은 성공) 서버가 토스 승인을 보상 취소한다.
  요청 형식: Authorization: Bearer <access token>, body { paymentKey, orderId, amount }.
*/
import { buildDeps, bearerToken, createAdminClient } from "../../../../lib/payments/server/deps";
import { handleConfirm } from "../../../../lib/payments/server/lifecycle";

function json(body: unknown, status = 200) {
  return Response.json(body, { status });
}

export async function POST(request: Request) {
  const secret = process.env.TOSS_SECRET_KEY;
  if (!secret) return json({ error: "결제 서버 설정이 없어요(TOSS_SECRET_KEY)" }, 500);
  const admin = createAdminClient();
  if (!admin) return json({ error: "결제 서버 설정이 없어요(SUPABASE_SERVICE_ROLE_KEY)" }, 500);

  let body: { paymentKey?: unknown; orderId?: unknown; amount?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ error: "요청 형식이 올바르지 않아요" }, 400);
  }
  const reply = await handleConfirm({ token: bearerToken(request), ...body }, buildDeps(admin, secret));
  return json(reply.body, reply.status);
}
