/*
  센터 → 플랫폼 구독 데이터 함수
  - 매니저: 내 센터 구독 상태 조회 + (플래그가 켜졌을 때만) 카드 등록 요청
  - 운영자: 전체 센터 구독 현황 조회
  - DB 쪽 스키마/RLS: add_center_platform_subscription.sql 참고

  실제 카드 등록(토스 자동결제 SDK)은 NEXT_PUBLIC_BILLING_ENABLED가 정확히
  "true"일 때만 동작한다. 토스 자동결제는 계약 심사가 끝나야 카드 등록(빌링키
  발급)이 가능해서(심사 전 테스트 키로 시도하면 에러가 난다는 게 토스 공식
  문서로 확인됨), 심사가 끝나기 전까지는 이 플래그를 켜지 않는다.

  ※ requestBillingAuth로 카드 등록 창을 여는 것까지만 이 함수가 담당한다.
    등록이 실제로 성공했을 때 토스가 돌려주는 authKey를 billing_key로 교환해서
    center_subscriptions에 저장하는 처리는 여기 없다 — 그 교환은 토스 시크릿
    키가 필요한 서버 전용 작업인데, 이 앱은 별도 API 서버가 없어서 이번 배치
    범위 밖으로 뒀다(토스 승인 후 별도 작업 필요, docs/TODO.md 참고).
*/

import { supabase } from "./supabaseClient";

export type SubscriptionStatus = "pending_billing_setup" | "active" | "past_due" | "canceled";

export type CenterSubscription = {
  id: string;
  centerId: string;
  planName: string;
  monthlyPrice: number;
  status: SubscriptionStatus;
  cardLast4: string | null;
  cardCompany: string | null;
  nextBillingDate: string | null; // "YYYY-MM-DD"
  updatedAt: string;
};

export type AdminCenterSubscription = CenterSubscription & {
  centerName: string;
};

export const STATUS_LABEL: Record<SubscriptionStatus, string> = {
  pending_billing_setup: "카드 등록 대기",
  active: "정상",
  past_due: "연체",
  canceled: "해지됨",
};

// 결제 연동 활성화 여부. 값이 정확히 "true"가 아니면(비워둔 경우 포함) 항상 꺼짐.
export const BILLING_ENABLED = process.env.NEXT_PUBLIC_BILLING_ENABLED === "true";

type SubscriptionPlanEmbed = { name: string; monthly_price: number } | null;

type CenterSubscriptionRow = {
  id: string;
  center_id: string;
  status: SubscriptionStatus;
  card_last4: string | null;
  card_company: string | null;
  next_billing_date: string | null;
  updated_at: string;
  subscription_plans: SubscriptionPlanEmbed;
};

type AdminCenterSubscriptionRow = CenterSubscriptionRow & {
  centers: { name: string } | null;
};

function rowToSubscription(r: CenterSubscriptionRow): CenterSubscription {
  return {
    id: r.id,
    centerId: r.center_id,
    planName: r.subscription_plans?.name ?? "-",
    monthlyPrice: r.subscription_plans?.monthly_price ?? 0,
    status: r.status,
    cardLast4: r.card_last4,
    cardCompany: r.card_company,
    nextBillingDate: r.next_billing_date,
    updatedAt: r.updated_at,
  };
}

const SELECT_COLUMNS =
  "id, center_id, status, card_last4, card_company, next_billing_date, updated_at, subscription_plans(name, monthly_price)";

// 매니저 - 내 센터의 구독 상태 조회.
// 신규 센터는 트리거가 행을 자동으로 만들지만, 트리거 적용 전에 만들어진 데이터
// 등 예외 상황을 방어적으로 처리하기 위해 행이 없으면 null을 반환한다(화면에서
// "구독 정보가 아직 없어요" 같은 안내로 처리).
export async function fetchCenterSubscription(centerId: string): Promise<CenterSubscription | null> {
  const { data, error } = await supabase
    .from("center_subscriptions")
    .select(SELECT_COLUMNS)
    .eq("center_id", centerId)
    .maybeSingle();
  if (error) throw new Error("구독 정보를 불러오지 못했어요: " + error.message);
  if (!data) return null;
  return rowToSubscription(data as unknown as CenterSubscriptionRow);
}

// 운영자 - 전체 센터 구독 현황
export async function fetchAllCenterSubscriptions(): Promise<AdminCenterSubscription[]> {
  const { data, error } = await supabase
    .from("center_subscriptions")
    .select(SELECT_COLUMNS + ", centers(name)")
    .order("updated_at", { ascending: false });
  if (error) throw new Error("구독 현황을 불러오지 못했어요: " + error.message);
  return ((data as unknown as AdminCenterSubscriptionRow[]) ?? []).map((r) => ({
    ...rowToSubscription(r),
    centerName: r.centers?.name ?? "-",
  }));
}

// ------------------------------------------------------------
// 토스 자동결제 카드 등록 (플래그 on일 때만 실제로 호출됨)
// ------------------------------------------------------------

type TossPaymentInstance = {
  requestBillingAuth: (opts: {
    method: "CARD";
    successUrl: string;
    failUrl: string;
  }) => Promise<void>;
};

type TossPaymentsSdk = {
  payment: (opts: { customerKey: string }) => TossPaymentInstance;
};

declare global {
  interface Window {
    TossPayments?: (clientKey: string) => TossPaymentsSdk;
  }
}

const TOSS_SDK_SRC = "https://js.tosspayments.com/v2/standard";

function loadTossSdk(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.TossPayments) {
      resolve();
      return;
    }
    const existing = document.querySelector(`script[src="${TOSS_SDK_SRC}"]`);
    if (existing) {
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () => reject(new Error("토스 결제 SDK를 불러오지 못했어요")));
      return;
    }
    const script = document.createElement("script");
    script.src = TOSS_SDK_SRC;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("토스 결제 SDK를 불러오지 못했어요"));
    document.head.appendChild(script);
  });
}

// 센터별로 결정적으로 계산되는 토스 customerKey(예: "center-<uuid>"). 카드 등록에
// 성공한 뒤 서버(향후 작업)가 같은 값을 billing_customer_key 컬럼에 기록해두면
// 이후 조회·재등록과도 값이 일치한다.
export function tossCustomerKeyForCenter(centerId: string): string {
  return `center-${centerId}`;
}

// 카드 등록 창 열기. NEXT_PUBLIC_BILLING_ENABLED가 꺼져 있으면 항상 예외를
// 던진다 — 호출하는 화면 쪽에서도 버튼 자체를 비활성화해 이 경로를 이중으로
// 막아둔다(플래그가 꺼진 상태에서 실제로 호출되면 토스 쪽에서 계약 심사 관련
// 에러가 나기 때문).
export async function requestCenterBillingAuth(centerId: string): Promise<void> {
  if (!BILLING_ENABLED) {
    throw new Error("구독 결제 연동이 아직 꺼져 있어요");
  }
  const clientKey = process.env.NEXT_PUBLIC_TOSS_BILLING_CLIENT_KEY;
  if (!clientKey) {
    throw new Error("결제 연동 설정(NEXT_PUBLIC_TOSS_BILLING_CLIENT_KEY)이 비어 있어요");
  }
  await loadTossSdk();
  if (!window.TossPayments) throw new Error("토스 결제 SDK 초기화에 실패했어요");

  const tossPayments = window.TossPayments(clientKey);
  const payment = tossPayments.payment({ customerKey: tossCustomerKeyForCenter(centerId) });
  const origin = window.location.origin;
  await payment.requestBillingAuth({
    method: "CARD",
    successUrl: `${origin}/manager/settings?billing=success&center=${centerId}`,
    failUrl: `${origin}/manager/settings?billing=fail&center=${centerId}`,
  });
}
