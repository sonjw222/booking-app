/*
  PaymentProviderFactory - PaymentService가 구체 Provider를 직접 생성하지 않도록
  선택/조립 책임을 전담하는 곳 (DIP 유지의 핵심)

  NEXT_PUBLIC_PAYMENT_PROVIDER 값만 바꾸면 mock → toss → portone 전환.
  provider 선택 자체는 클라이언트 번들에서 읽으므로 NEXT_PUBLIC_ 접두사를 유지한다.
  시크릿 키(TOSS_SECRET_KEY 등)는 app/api/payments/*(서버 전용) 라우트에서만 읽는다.
*/

import type { PaymentProvider, PaymentScenario } from "./types";
import { MockPaymentProvider } from "./MockPaymentProvider";
import { NicepayPaymentProvider } from "./NicepayPaymentProvider";
import { DisabledPaymentProvider } from "./DisabledPaymentProvider";

/*
  PG 사업자 확정(2026-10-16, 사용자 결정): 신규 PG는 NICEPAY 하나뿐이다. Toss/PortOne은 신규 결제에 선택되지 않는다.
    "mock"    : 테스트 결제(기본값 — 값이 없거나 알 수 없을 때)
    "nicepay" : 계약·MID/KEY·서버 승인 연동 전까지 NicepayPaymentProvider가 모든 호출을 거부한다(fail-closed)
    "disabled": 은퇴한 PG 값(toss/portone) 또는 Mock이 허용되지 않은 환경의 빈/알 수 없는 값. 모든 결제 시도를 거부한다(조용히 mock으로 떨어지지 않음).
  과거 Toss 거래의 조회·취소·환불은 이 Provider가 아니라 서버 라우트(app/api/payments/*, lib/payments/server/*)가 처리하므로 영향 없다.
  시크릿 키는 app/api/payments/*(서버 전용) 라우트에서만 읽는다.
*/
export type PaymentProviderName = "mock" | "nicepay" | "disabled";

// Mock(결제 없이 주문을 완료로 만드는 테스트 결제)은 명시적으로 허용된 환경에서만 쓴다:
//   · 개발/테스트(NODE_ENV !== "production") — 값이 비어 있거나 "mock"이거나 알 수 없는 값이어도 mock(기존 동작)
//   · 운영 빌드(Vercel Preview/Production 포함) — NEXT_PUBLIC_ALLOW_MOCK_PAYMENT === "true"를 따로 켠 경우에만 mock
// 그 밖에는 값이 없거나 알 수 없어도 mock으로 폴백하지 않고 "disabled"(모든 결제 호출 거부)다. "nicepay"는 어떤 환경에서도 mock이 되지 않는다.
// DB에서도 confirm_test_payment는 payment_provider='mock' + 내부 QA 센터(is_internal)에서만 동작한다(fix_pg_payment_lifecycle.sql) — 앱 잠금은 이중 안전장치.
export function isMockPaymentAllowed(): boolean {
  return process.env.NODE_ENV !== "production" || process.env.NEXT_PUBLIC_ALLOW_MOCK_PAYMENT === "true";
}

export function resolveProviderName(): PaymentProviderName {
  const raw = process.env.NEXT_PUBLIC_PAYMENT_PROVIDER;
  if (raw === "nicepay") return "nicepay";
  if (raw === "toss" || raw === "portone") return "disabled";   // 은퇴한 PG — 어떤 환경에서도 mock으로 대체하지 않는다
  if (!isMockPaymentAllowed()) return "disabled";
  return "mock";
}

// 코드 수준 이중 잠금: 환경변수를 nicepay로 바꿔도 이 상수를 true로 바꾸는 리뷰된 코드 변경(계약·SQL·서버 승인 라우트 완료 후) 없이는 결제창을 열지 않는다.
export const NICEPAY_CHECKOUT_ACTIVATED: boolean = false;

// 실제 PG 결제창으로 진행해도 되는 상태인지. mock은 PG가 아니므로 false.
export function isOnlinePgCheckoutAvailable(): boolean {
  return resolveProviderName() === "nicepay" && NICEPAY_CHECKOUT_ACTIVATED;
}

// PG 결제수단(카드/카카오페이/토스페이/계좌이체) 노출 여부. 값이 정확히 "true"가 아니면(비워둔 경우 포함) 항상 꺼짐 = 직접결제만 노출.
// (BILLING_ENABLED/PAYOUTS_ENABLED와 동일한 패턴, 사용자 결정 2026-09-04)
export const PG_CHECKOUT_ENABLED = process.env.NEXT_PUBLIC_PG_CHECKOUT_ENABLED === "true";

// mockScenarioOverride: Mock일 때만 의미 있음(예: checkout의 ?mockScenario= 쿼리로 재빌드 없이 success/failed/cancelled를 즉시 바꿔 QA하기 위함)
export function getPaymentProvider(mockScenarioOverride?: PaymentScenario): PaymentProvider {
  switch (resolveProviderName()) {
    case "nicepay":
      return new NicepayPaymentProvider();
    case "disabled":
      return new DisabledPaymentProvider();
    case "mock":
    default:
      return new MockPaymentProvider(mockScenarioOverride);
  }
}
