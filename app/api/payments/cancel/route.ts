/*
  결제 "승인 전" 주문 취소 서버 라우트 — 결제창을 닫거나 실패한 PG 주문을 cancelled로 되돌린다(차감한 포인트는 DB 트리거가 복원).
  이미 승인·발급된 주문은 이 경로로 취소할 수 없다(환불은 /api/payments/refund). 토스 취소 API는 호출하지 않는다.
  보안: Authorization: Bearer <access token> 필수(401), 본인 주문만(pg_order_context), pending 상태만. service_role은 위 검증 뒤 cancel_real_payment 호출에만 쓴다.
*/
import { buildDeps, bearerToken, createAdminClient } from "../../../../lib/payments/server/deps";
import { handleCancel } from "../../../../lib/payments/server/lifecycle";

function json(body: unknown, status = 200) {
  return Response.json(body, { status });
}

export async function POST(request: Request) {
  const admin = createAdminClient();
  if (!admin) return json({ error: "결제 서버 설정이 없어요(SUPABASE_SERVICE_ROLE_KEY)" }, 500);

  let body: { orderId?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ error: "요청 형식이 올바르지 않아요" }, 400);
  }
  // 이 경로는 토스를 호출하지 않으므로 시크릿 키를 넘기지 않는다(빈 값이면 deps가 토스 호출을 막는다).
  const reply = await handleCancel({ token: bearerToken(request), orderId: body.orderId }, buildDeps(admin, ""));
  return json(reply.body, reply.status);
}
