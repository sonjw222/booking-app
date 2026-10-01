/*
  회원 전체 환불 서버 라우트 — 브라우저는 refund_membership RPC를 직접 부르지 않고 이 라우트만 부른다(실 PG 주문은 DB 가드가 직접 호출을 거부).
  흐름은 lib/payments/server/lifecycle.ts handleRefund 참고:
    로그인 검증 → 본인 수강권/환불 가능 조건 확인 → (실 PG 주문) 토스 승인 취소 → DB 환불(쿠폰/포인트 복원 포함).
  direct/manual/mock 결제는 토스를 호출하지 않고 기존 DB 환불만 수행한다. 토스 시크릿이 없으면 PG 환불은 시작 전에 중단된다(DB 변경 없음).
*/
import { buildDeps, bearerToken, createAdminClient } from "../../../../lib/payments/server/deps";
import { handleRefund } from "../../../../lib/payments/server/lifecycle";

function json(body: unknown, status = 200) {
  return Response.json(body, { status });
}

export async function POST(request: Request) {
  const admin = createAdminClient();
  if (!admin) return json({ error: "결제 서버 설정이 없어요(SUPABASE_SERVICE_ROLE_KEY)" }, 500);

  let body: { membershipId?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ error: "요청 형식이 올바르지 않아요" }, 400);
  }
  const reply = await handleRefund(
    { token: bearerToken(request), membershipId: body.membershipId },
    buildDeps(admin, process.env.TOSS_SECRET_KEY ?? ""),
  );
  return json(reply.body, reply.status);
}
