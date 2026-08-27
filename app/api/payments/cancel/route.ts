/*
  결제 취소 서버 라우트 — 아직 승인(confirm) 전 단계에서 사용자가 결제창을 닫거나
  실패한 경우, 주문을 cancelled로 되돌린다. 실제 토스 결제 자체가 이미 승인된 뒤의
  "환불"은 이 범위 밖(매니저 화면에서 별도 처리 — 이번 배치는 승인 전 취소만 다룸).
*/

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function json(body: unknown, status = 200) {
  return Response.json(body, { status });
}

export async function POST(request: Request) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return json({ error: "결제 서버 설정이 없어요(SUPABASE_SERVICE_ROLE_KEY)" }, 500);
  }

  let body: { orderId?: string };
  try {
    body = await request.json();
  } catch {
    return json({ error: "요청 형식이 올바르지 않아요" }, 400);
  }
  if (!body.orderId) return json({ error: "orderId가 필요해요" }, 400);

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data, error } = await admin.rpc("cancel_real_payment", { p_order_id: body.orderId });
  if (error) return json({ error: error.message }, 500);

  return json({ ok: true, ...data });
}
