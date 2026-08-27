/*
  결제 승인(confirm) 서버 라우트 — 이 프로젝트 최초의 app/api 라우트.

  토스페이먼츠 결제 승인 API는 시크릿 키(TOSS_SECRET_KEY)로 서버-서버 통신을 해야 하는데,
  이 프로젝트는 지금까지 100% 클라이언트 컴포넌트 구조였다(PaymentProviderFactory.ts 상단
  주석 참고). 결제창에서 successUrl로 리다이렉트된 뒤(app/checkout/success/page.tsx)
  브라우저가 이 라우트를 호출하고, 여기서만 시크릿 키를 사용한다 — 절대 브라우저 번들에
  포함되지 않는다(NEXT_PUBLIC_ 접두사 없음).

  흐름: 토스 승인 API 호출(Basic Auth) → 성공하면 service_role로 confirm_real_payment RPC
  호출(수강권 발급 + 매출 기록 + 주문 완료 처리) → 결과 반환.
*/

import { createClient } from "@supabase/supabase-js";

const TOSS_SECRET_KEY = process.env.TOSS_SECRET_KEY;
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function json(body: unknown, status = 200) {
  return Response.json(body, { status });
}

export async function POST(request: Request) {
  if (!TOSS_SECRET_KEY) return json({ error: "결제 서버 설정이 없어요(TOSS_SECRET_KEY)" }, 500);
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return json({ error: "결제 서버 설정이 없어요(SUPABASE_SERVICE_ROLE_KEY)" }, 500);
  }

  let body: { paymentKey?: string; orderId?: string; amount?: number };
  try {
    body = await request.json();
  } catch {
    return json({ error: "요청 형식이 올바르지 않아요" }, 400);
  }
  const { paymentKey, orderId, amount } = body;
  if (!paymentKey || !orderId || typeof amount !== "number") {
    return json({ error: "paymentKey/orderId/amount가 모두 필요해요" }, 400);
  }

  // 1) 토스 결제 승인 API 호출 (서버-서버, 시크릿 키 Basic Auth)
  const credentials = Buffer.from(`${TOSS_SECRET_KEY}:`).toString("base64");
  const tossRes = await fetch("https://api.tosspayments.com/v1/payments/confirm", {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ paymentKey, orderId, amount }),
  });
  const tossData = await tossRes.json();
  if (!tossRes.ok) {
    return json({ error: tossData?.message ?? "결제 승인에 실패했어요" }, tossRes.status);
  }
  // 토스가 응답한 실제 승인 금액으로 한 번 더 검증(요청 금액을 그대로 믿지 않음)
  const confirmedAmount = typeof tossData?.totalAmount === "number" ? tossData.totalAmount : amount;

  // 2) service_role로 confirm_real_payment RPC 호출 — 이미 승인된 결제이므로 RLS 우회 필요
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data, error } = await admin.rpc("confirm_real_payment", {
    p_order_id: orderId,
    p_payment_key: paymentKey,
    p_amount: confirmedAmount,
  });
  if (error) {
    // 토스 결제는 이미 승인됐는데 우리 쪽 확정이 실패한 상태 — 데이터 정합성 문제이므로
    // 5xx로 명확히 알린다(매니저가 /manager/orders에서 수동 확인 가능, pg_transaction_id
    // 없이도 토스 대시보드에서 paymentKey로 대조 가능).
    return json({ error: `결제는 승인됐지만 확정 처리에 실패했어요: ${error.message}` }, 500);
  }

  return json({ ok: true, ...data });
}
