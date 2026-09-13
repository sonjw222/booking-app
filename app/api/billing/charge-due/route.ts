/*
  센터 → 플랫폼 월 구독료 — 2회차 이후 자동(정기) 청구.

  add_center_subscription_recurring_billing.sql이 등록한 pg_cron("dispatch-center-billing",
  하루 1회)이 이 라우트를 호출한다. 사람이 직접 호출하는 화면은 없다 — x-cron-secret
  헤더(BILLING_CRON_SECRET, Vercel 환경변수)로만 인증하고, 일치하지 않으면 즉시 401로
  끝낸다(과금 로직에 도달하지 않음).

  app/api/billing/confirm/route.ts(최초 1회 결제)와 역할이 다르다:
    - confirm: 카드 등록 직후 딱 한 번, authKey→billingKey 교환까지 포함
    - 이 라우트: 이미 billing_key가 저장된 구독을 대상으로 매월 정기 청구만 반복

  중복 청구 방지(idempotency) — 2단계 방어:
    1) DB 리스: center_subscriptions.billing_locked_until을 이 요청이 먼저 원자적으로
       선점(UPDATE ... WHERE billing_locked_until is null or 만료 RETURNING *)해서, 같은
       구독이 동시에 두 번 처리되지 않게 한다.
    2) 토스 orderId 유일성: 같은 회차(next_billing_date)는 항상 같은 orderId
       (sub-recur-{centerId}-{next_billing_date})를 쓴다 — 1)이 실패하더라도 토스가
       중복 orderId 결제를 거부해준다.

  가격은 이번에도 클라이언트(=우리 자신의 저장된 값이 아니라 매 실행 시점의
  subscription_plans.monthly_price)를 다시 조회해서 쓴다 — 운영자가 플랜 가격을 바꾸면
  다음 청구부터 바로 새 가격이 적용되도록.

  실패 정책(연체): 청구 실패 시 status를 'past_due'로 바꾸고 next_billing_date는 건드리지
  않는다 — 다음 날 실행에서 같은 회차로 다시 시도된다(성공할 때까지 매일 재시도). 몇 번
  실패하면 자동 해지할지 같은 정교한 연체 정책은 사업 결정 사항이라 이 배치에 넣지 않았다
  (docs/TODO.md P0-8 참고). past_due 상태에서 오너가 카드를 직접 바꾸는 화면은 아직 없다.
*/

import { createClient } from "@supabase/supabase-js";

export const maxDuration = 60;

const BILLING_CRON_SECRET = process.env.BILLING_CRON_SECRET;
const TOSS_SECRET_KEY = process.env.TOSS_SECRET_KEY;
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// 리스 유효기간 — 이 시간 안에 처리가 안 끝나면(서버 크래시 등) 다음 실행이 다시 집을 수
// 있다. 하루 1회 실행인데 15분이면 충분하고도 남는다(실제 청구 대상은 당분간 소수).
const LEASE_MINUTES = 15;

function json(body: unknown, status = 200) {
  return Response.json(body, { status });
}

function tossAuthHeader(): string {
  return "Basic " + Buffer.from(`${TOSS_SECRET_KEY}:`).toString("base64");
}

function addOneMonth(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString().slice(0, 10);
}

type ClaimedRow = {
  id: string;
  center_id: string;
  billing_key: string | null;
  billing_customer_key: string | null;
  next_billing_date: string | null;
  subscription_plans: { name: string; monthly_price: number } | null;
};

export async function POST(request: Request) {
  if (!BILLING_CRON_SECRET || request.headers.get("x-cron-secret") !== BILLING_CRON_SECRET) {
    return json({ error: "unauthorized" }, 401);
  }
  if (!TOSS_SECRET_KEY) return json({ error: "결제 서버 설정이 없어요(TOSS_SECRET_KEY)" }, 500);
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return json({ error: "결제 서버 설정이 없어요(SUPABASE_SERVICE_ROLE_KEY)" }, 500);
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const leaseUntil = new Date(now.getTime() + LEASE_MINUTES * 60_000).toISOString();

  // 원자적 선점(claim) — 이 UPDATE가 단일 문장이라 동시에 같은 구독을 두 번 집을 수 없다.
  const { data: claimed, error: claimErr } = await admin
    .from("center_subscriptions")
    .update({ billing_locked_until: leaseUntil })
    .in("status", ["active", "past_due"])
    .lte("next_billing_date", todayStr)
    .or(`billing_locked_until.is.null,billing_locked_until.lt.${now.toISOString()}`)
    .select("id, center_id, billing_key, billing_customer_key, next_billing_date, subscription_plans(name, monthly_price)");

  if (claimErr) return json({ error: `대상 조회 실패: ${claimErr.message}` }, 500);

  const rows = (claimed ?? []) as unknown as ClaimedRow[];
  let succeeded = 0, failed = 0, skippedZeroPrice = 0, skippedNoBillingKey = 0;

  for (const row of rows) {
    const plan = row.subscription_plans;
    const amount = plan?.monthly_price ?? 0;
    const dueDate = row.next_billing_date ?? todayStr;

    // 무료(0원) 플랜으로 바뀐 구독 — 토스 호출 없이 다음 달로만 넘긴다.
    if (amount <= 0) {
      skippedZeroPrice++;
      await admin.from("center_subscriptions").update({
        status: "active", next_billing_date: addOneMonth(dueDate), billing_locked_until: null,
      }).eq("id", row.id);
      continue;
    }

    if (!row.billing_key || !row.billing_customer_key) {
      // 정상적으로는 발생하지 않아야 함(active/past_due는 최초 결제 성공 후에만 도달) —
      // 방어적으로 past_due 처리하고 리스만 해제.
      skippedNoBillingKey++;
      await admin.from("center_subscriptions").update({
        status: "past_due", billing_locked_until: null,
      }).eq("id", row.id);
      await admin.from("center_subscription_charges").insert({
        subscription_id: row.id, amount, status: "failed",
        failure_reason: "billing_key/billing_customer_key 없음",
      });
      failed++;
      continue;
    }

    // 같은 회차는 항상 같은 orderId — 재시도해도 토스가 중복 청구를 거부하도록.
    const orderId = `sub-recur-${row.center_id}-${dueDate}`;

    let chargeRes: Response;
    let chargeData: any;
    try {
      chargeRes = await fetch(`https://api.tosspayments.com/v1/billing/${row.billing_key}`, {
        method: "POST",
        headers: { Authorization: tossAuthHeader(), "Content-Type": "application/json" },
        body: JSON.stringify({
          customerKey: row.billing_customer_key, amount, orderId,
          orderName: `${plan?.name ?? "플랫폼 구독"} 정기결제 (${dueDate})`,
        }),
      });
      chargeData = await chargeRes.json();
    } catch (e: any) {
      // 네트워크 오류 등 — 실패로 기록하고 다음 실행에서 재시도(리스만 해제).
      await admin.from("center_subscriptions").update({
        status: "past_due", billing_locked_until: null,
      }).eq("id", row.id);
      await admin.from("center_subscription_charges").insert({
        subscription_id: row.id, amount, order_id: orderId, status: "failed",
        failure_reason: `요청 실패: ${e?.message ?? "알 수 없는 오류"}`,
      });
      failed++;
      continue;
    }

    if (!chargeRes.ok) {
      await admin.from("center_subscriptions").update({
        status: "past_due", billing_locked_until: null,
      }).eq("id", row.id);
      await admin.from("center_subscription_charges").insert({
        subscription_id: row.id, amount, order_id: orderId, status: "failed",
        failure_reason: chargeData?.message ?? `HTTP ${chargeRes.status}`,
      });
      failed++;
      continue;
    }

    await admin.from("center_subscriptions").update({
      status: "active", next_billing_date: addOneMonth(dueDate), billing_locked_until: null,
    }).eq("id", row.id);
    await admin.from("center_subscription_charges").insert({
      subscription_id: row.id, amount, order_id: orderId, status: "succeeded",
      toss_payment_key: chargeData?.paymentKey ?? null,
    });
    succeeded++;
  }

  return json({
    ok: true, claimed: rows.length, succeeded, failed,
    skippedZeroPrice, skippedNoBillingKey,
  });
}
