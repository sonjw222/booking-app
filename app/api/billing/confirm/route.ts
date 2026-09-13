/*
  센터 → 플랫폼 구독 빌링키 발급 + 최초 결제 확정 서버 라우트.

  토스 자동결제(Billing) v2 SDK의 requestBillingAuth()가 성공하면 브라우저가
  successUrl(app/manager/subscription?billing=success&center=...)로 authKey/customerKey
  쿼리를 붙여 리다이렉트한다(lib/centerSubscription.ts의 requestCenterBillingAuth 참고).
  authKey → billingKey 교환과 최초 결제는 시크릿 키가 필요해 브라우저에서 직접 못 하므로,
  app/api/payments/confirm(일반 결제)과 동일한 패턴으로 여기서만 시크릿 키를 사용한다.

  흐름(토스 공식 문서, 2026-09 기준):
    1) POST https://api.tosspayments.com/v1/billing/authorizations/issue
       { authKey, customerKey } → billingKey 발급
    2) POST https://api.tosspayments.com/v1/billing/{billingKey}
       { customerKey, amount, orderId, orderName } → 최초 결제 청구
    3) 결과를 center_subscriptions/center_subscription_charges에 반영(service_role,
       두 테이블 다 RLS insert/update 정책이 없어 service_role 전용 — add_center_platform_subscription.sql 참고)

  금액은 절대 클라이언트가 보낸 값을 쓰지 않는다 — center_subscriptions.plan_id로 조인한
  subscription_plans.monthly_price를 서버에서 직접 조회해 사용한다.
*/

import { createClient } from "@supabase/supabase-js";

const TOSS_SECRET_KEY = process.env.TOSS_SECRET_KEY;
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// 토스페이먼츠 카드사 코드 enum(docs.tosspayments.com/reference/codes, 2026-09 확인) —
// billing/authorizations/issue 응답의 card.issuerCode는 카드사명이 아니라 이 2자리
// 코드로만 오므로, 화면 표시용(card_company)으로 이름으로 변환해둔다.
const CARD_ISSUER_NAMES: Record<string, string> = {
  "3K": "기업 BC", "46": "광주은행", "71": "롯데카드", "30": "한국산업은행",
  "31": "BC카드", "51": "삼성카드", "38": "새마을금고", "41": "신한카드",
  "62": "신협", "36": "씨티카드", "33": "우리BC카드", "W1": "우리카드",
  "37": "우체국예금보험", "39": "저축은행중앙회", "35": "전북은행", "42": "제주은행",
  "15": "카카오뱅크", "3A": "케이뱅크", "24": "토스뱅크", "21": "하나카드",
  "61": "현대카드", "11": "KB국민카드", "91": "NH농협카드", "34": "Sh수협은행",
  "6D": "다이너스 클럽", "4M": "마스터카드", "3C": "유니온페이", "7A": "아메리칸 익스프레스",
  "4J": "JCB", "4V": "VISA",
};

function json(body: unknown, status = 200) {
  return Response.json(body, { status });
}

function tossAuthHeader(): string {
  return "Basic " + Buffer.from(`${TOSS_SECRET_KEY}:`).toString("base64");
}

export async function POST(request: Request) {
  if (!TOSS_SECRET_KEY) return json({ error: "결제 서버 설정이 없어요(TOSS_SECRET_KEY)" }, 500);
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return json({ error: "결제 서버 설정이 없어요(SUPABASE_SERVICE_ROLE_KEY)" }, 500);
  }

  let body: { authKey?: string; customerKey?: string; centerId?: string };
  try {
    body = await request.json();
  } catch {
    return json({ error: "요청 형식이 올바르지 않아요" }, 400);
  }
  const { authKey, customerKey, centerId } = body;
  if (!authKey || !customerKey || !centerId) {
    return json({ error: "authKey/customerKey/centerId가 모두 필요해요" }, 400);
  }
  // customerKey는 lib/centerSubscription.ts의 tossCustomerKeyForCenter()와 동일한 규칙으로만
  // 발급됐어야 한다 — centerId와 짝이 맞는지 방어적으로 재확인(형식 위조 방지).
  if (customerKey !== `center-${centerId}`) {
    return json({ error: "customerKey가 올바르지 않아요" }, 400);
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // 원자적 선점(claim) — 성공/실패 콜백이 네트워크 재시도 등으로 거의 동시에 두 번 와도
  // (예: 브라우저가 successUrl 요청을 중복 전송) 단일 UPDATE...WHERE...RETURNING이라
  // 한쪽만 행을 받는다(app/api/billing/charge-due/route.ts와 동일한 리스 패턴 재사용 —
  // billing_locked_until, add_center_subscription_recurring_billing.sql). 이 라우트는
  // 처리가 몇 초 안에 끝나므로 짧은 리스로 충분.
  // pending_billing_setup(최초 등록) 또는 payment_failed(2026-09-14 정책 — 정기 청구
  // 7회 실패/재시도 무의미한 카드 오류로 자동중지된 구독을 새 카드로 재등록해 재개하는
  // 경로, add_center_subscription_billing_retry_policy.sql) 둘 다 대상.
  const leaseUntil = new Date(Date.now() + 2 * 60_000).toISOString();
  const { data: sub, error: subErr } = await admin
    .from("center_subscriptions")
    .update({ billing_locked_until: leaseUntil })
    .eq("center_id", centerId)
    .in("status", ["pending_billing_setup", "payment_failed"])
    .or(`billing_locked_until.is.null,billing_locked_until.lt.${new Date().toISOString()}`)
    .select("id, status, subscription_plans(name, monthly_price)")
    .maybeSingle();
  if (subErr) return json({ error: `구독 정보 조회 실패: ${subErr.message}` }, 500);
  if (!sub) {
    // 이미 카드가 등록돼 정상 운영 중(active/past_due)이거나, 다른 요청이 방금 먼저
    // 선점한 경우 — 매번 재청구하면 안 되므로 여기서 막는다.
    return json({ error: "이미 카드가 등록됐거나 처리 중인 구독이에요" }, 409);
  }
  const plan = sub.subscription_plans as unknown as { name: string; monthly_price: number } | null;
  const amount = plan?.monthly_price ?? 0;
  if (amount <= 0) {
    // 여기서 실패해도 리스는 반드시 풀어준다 — 안 풀면 최대 2분간 재시도가 막힌다.
    await admin.from("center_subscriptions").update({ billing_locked_until: null }).eq("id", sub.id);
    return json({ error: "플랜 가격이 아직 설정되지 않았어요 — 운영자에게 문의해주세요" }, 400);
  }

  // 1) authKey → billingKey 교환
  const issueRes = await fetch("https://api.tosspayments.com/v1/billing/authorizations/issue", {
    method: "POST",
    headers: { Authorization: tossAuthHeader(), "Content-Type": "application/json" },
    body: JSON.stringify({ authKey, customerKey }),
  });
  const issueData = await issueRes.json();
  if (!issueRes.ok) {
    await admin.from("center_subscriptions").update({ billing_locked_until: null }).eq("id", sub.id);
    await admin.from("center_subscription_charges").insert({
      subscription_id: sub.id, amount, status: "failed",
      failure_reason: issueData?.message ?? `billingKey 발급 실패 HTTP ${issueRes.status}`,
    });
    return json({ error: issueData?.message ?? "카드 등록에 실패했어요" }, issueRes.status);
  }
  const billingKey: string = issueData.billingKey;
  const issuerCode: string | undefined = issueData.card?.issuerCode;
  const cardCompany = issuerCode ? (CARD_ISSUER_NAMES[issuerCode] ?? issuerCode) : null;
  const cardNumberDigits = String(issueData.card?.number ?? "").replace(/\D/g, "");
  const cardLast4 = cardNumberDigits ? cardNumberDigits.slice(-4) : null;

  // 2) 최초 결제 청구(1회차)
  const orderId = `sub-first-${centerId}-${Date.now()}`;
  const chargeRes = await fetch(`https://api.tosspayments.com/v1/billing/${billingKey}`, {
    method: "POST",
    headers: { Authorization: tossAuthHeader(), "Content-Type": "application/json" },
    body: JSON.stringify({
      customerKey, amount, orderId,
      orderName: `${plan?.name ?? "플랫폼 구독"} 정기결제`,
    }),
  });
  const chargeData = await chargeRes.json();

  const nextBillingDate = new Date();
  nextBillingDate.setMonth(nextBillingDate.getMonth() + 1);
  const nextBillingDateStr = nextBillingDate.toISOString().slice(0, 10);

  if (!chargeRes.ok) {
    // 카드 등록 자체는 성공했으니 카드 정보는 저장해두되(재등록을 강요하지 않기 위해),
    // 첫 결제가 실패했으므로 status는 active로 전환하지 않는다 — pending_billing_setup에
    // 그대로 남아 매니저 화면에 "카드 등록" 버튼이 다시 뜬다(카드를 다시 등록하면 이
    // 라우트가 재시도된다).
    await admin.from("center_subscriptions").update({
      billing_key: billingKey, billing_customer_key: customerKey,
      card_last4: cardLast4, card_company: cardCompany, billing_locked_until: null,
    }).eq("id", sub.id);
    await admin.from("center_subscription_charges").insert({
      subscription_id: sub.id, amount, order_id: orderId, status: "failed",
      failure_reason: chargeData?.message ?? `HTTP ${chargeRes.status}`,
    });
    return json({ error: `카드는 등록됐지만 첫 결제에 실패했어요: ${chargeData?.message ?? "알 수 없는 오류"}` }, 402);
  }

  await admin.from("center_subscriptions").update({
    billing_key: billingKey, billing_customer_key: customerKey,
    card_last4: cardLast4, card_company: cardCompany,
    status: "active", next_billing_date: nextBillingDateStr, billing_locked_until: null,
    retry_count: 0, // payment_failed에서 새 카드로 재등록한 경우 연속 실패 카운트 초기화
  }).eq("id", sub.id);
  await admin.from("center_subscription_charges").insert({
    subscription_id: sub.id, amount, order_id: orderId, status: "succeeded",
    toss_payment_key: chargeData?.paymentKey ?? null,
  });

  return json({ ok: true, status: "active", nextBillingDate: nextBillingDateStr });
}
