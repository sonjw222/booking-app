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

  실패 정책(연체, 2026-09-14 확정 — add_center_subscription_billing_retry_policy.sql):
  청구 실패 시 retry_count를 1 증가시키고 status='past_due'로 표시, next_billing_date는
  건드리지 않는다 — 다음 날 실행에서 같은 회차로 다시 시도된다. retry_count가 최대치
  (MAX_RETRY_COUNT=7, 하루 1회 재시도라 최대 유예기간 7일과 동일)에 도달하면 자동
  재시도를 완전히 중단하고 status='payment_failed'(terminal)로 전환 — charge-due의
  대상 쿼리(status in ('active','past_due'))에서 자연히 제외된다. billing_key 등
  기존 카드 정보는 삭제하지 않는다(감사 보존) — 오너가 새 카드를 등록하면
  app/api/billing/confirm/route.ts가 payment_failed도 재등록 대상으로 받아 active로
  되돌린다.

  카드 만료/분실/정지처럼 재시도해도 성공 가능성이 없는 것으로 토스가 명시적으로 알려주는
  오류는 retry_count를 채우기 전에 즉시 payment_failed로 전환한다(불필요한 반복 청구
  방지) — NON_RETRYABLE_CARD_ERROR_CODES 참고. 이 목록에 없는(=확실히 판단할 수 없는)
  코드는 전부 안전하게 기본 7회 재시도 정책으로 처리한다.
*/

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export const maxDuration = 60;

const BILLING_CRON_SECRET = process.env.BILLING_CRON_SECRET;
const TOSS_SECRET_KEY = process.env.TOSS_SECRET_KEY;
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// 리스 유효기간 — 이 시간 안에 처리가 안 끝나면(서버 크래시 등) 다음 실행이 다시 집을 수
// 있다. 하루 1회 실행인데 15분이면 충분하고도 남는다(실제 청구 대상은 당분간 소수).
const LEASE_MINUTES = 15;

// 하루 1회 재시도 기준 최대 유예기간과 동일한 7일 = 7회(사용자 확정 정책, 2026-09-14).
const MAX_RETRY_COUNT = 7;

// docs.tosspayments.com/reference/error-codes 조회 결과 기준(2026-09-14) — 카드 자체의
// 문제라 재시도해도 성공할 수 없는 오류만 골랐다. 토스가 코드를 추가/변경하면 이 목록도
// 갱신 필요. **이 목록에 없는 코드는 절대 추측해서 분류하지 않고 전부 기본 재시도
// 정책(MAX_RETRY_COUNT)으로 처리한다** — 목록이 불완전해도 안전한 쪽(더 재시도)으로만
// 치우치도록 설계.
const NON_RETRYABLE_CARD_ERROR_CODES = new Set([
  "INVALID_CARD_EXPIRATION",   // 카드 유효기간 오류/만료
  "INVALID_CARD_NUMBER",       // 카드번호 오류
  "INVALID_STOPPED_CARD",      // 정지된 카드
  "INVALID_CARD_LOST_OR_STOLEN", // 분실 또는 도난 카드
  "INVALID_CARD_IDENTITY",     // 카드 소유주 정보 불일치
  "NOT_REGISTERED_CARD_COMPANY", // 카드 사용 미등록
]);

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
  retry_count: number;
  subscription_plans: { name: string; monthly_price: number } | null;
};

type AdminClient = SupabaseClient;

// 실패 처리 공통 로직 — 세 실패 경로(billing_key 없음/네트워크 오류/토스 거절)가 전부
// 이걸 거쳐 retry_count 증가·terminal 판정·리스 해제를 일관되게 한다.
// forceTerminal: billing_key 없음처럼 재시도 자체가 무의미한 데이터 이상 상황.
// tossCode: 토스 응답의 code 필드 — NON_RETRYABLE_CARD_ERROR_CODES에 있으면 즉시 terminal.
async function recordFailure(
  admin: AdminClient, row: ClaimedRow, amount: number, orderId: string | null,
  failureReason: string, opts: { tossCode?: string; forceTerminal?: boolean } = {},
): Promise<{ terminal: boolean }> {
  const nonRetryable = opts.forceTerminal === true ||
    (opts.tossCode ? NON_RETRYABLE_CARD_ERROR_CODES.has(opts.tossCode) : false);
  const nextRetryCount = nonRetryable ? row.retry_count : row.retry_count + 1;
  const terminal = nonRetryable || nextRetryCount >= MAX_RETRY_COUNT;

  await admin.from("center_subscriptions").update({
    status: terminal ? "payment_failed" : "past_due",
    retry_count: nextRetryCount,
    billing_locked_until: null,
  }).eq("id", row.id);
  await admin.from("center_subscription_charges").insert({
    subscription_id: row.id, amount, order_id: orderId, status: "failed",
    failure_reason: failureReason,
  });
  return { terminal };
}

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
    .select("id, center_id, billing_key, billing_customer_key, next_billing_date, retry_count, subscription_plans(name, monthly_price)");

  if (claimErr) return json({ error: `대상 조회 실패: ${claimErr.message}` }, 500);

  const rows = (claimed ?? []) as unknown as ClaimedRow[];
  let succeeded = 0, failed = 0, suspended = 0, skippedZeroPrice = 0, skippedNoBillingKey = 0;

  for (const row of rows) {
    const plan = row.subscription_plans;
    const amount = plan?.monthly_price ?? 0;
    const dueDate = row.next_billing_date ?? todayStr;

    // 무료(0원) 플랜으로 바뀐 구독 — 토스 호출 없이 다음 달로만 넘긴다.
    if (amount <= 0) {
      skippedZeroPrice++;
      await admin.from("center_subscriptions").update({
        status: "active", next_billing_date: addOneMonth(dueDate),
        billing_locked_until: null, retry_count: 0,
      }).eq("id", row.id);
      continue;
    }

    if (!row.billing_key || !row.billing_customer_key) {
      // 정상적으로는 발생하지 않아야 함(active/past_due는 최초 결제 성공 후에만 도달) —
      // 재시도해도 해결되지 않는 데이터 이상 상황이라 즉시 terminal 처리.
      skippedNoBillingKey++;
      const { terminal } = await recordFailure(
        admin, row, amount, null, "billing_key/billing_customer_key 없음",
        { forceTerminal: true },
      );
      if (terminal) suspended++; else failed++;
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
      // 네트워크 오류 등 — 토스 오류코드가 아니므로 항상 기본 재시도 정책(7회)으로 처리.
      const { terminal } = await recordFailure(
        admin, row, amount, orderId, `요청 실패: ${e?.message ?? "알 수 없는 오류"}`,
      );
      if (terminal) suspended++; else failed++;
      continue;
    }

    if (!chargeRes.ok) {
      const { terminal } = await recordFailure(
        admin, row, amount, orderId, chargeData?.message ?? `HTTP ${chargeRes.status}`,
        { tossCode: chargeData?.code },
      );
      if (terminal) suspended++; else failed++;
      continue;
    }

    await admin.from("center_subscriptions").update({
      status: "active", next_billing_date: addOneMonth(dueDate),
      billing_locked_until: null, retry_count: 0,
    }).eq("id", row.id);
    await admin.from("center_subscription_charges").insert({
      subscription_id: row.id, amount, order_id: orderId, status: "succeeded",
      toss_payment_key: chargeData?.paymentKey ?? null,
    });
    succeeded++;
  }

  return json({
    ok: true, claimed: rows.length, succeeded, failed, suspended,
    skippedZeroPrice, skippedNoBillingKey,
  });
}
