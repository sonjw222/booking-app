/*
  NICEPAY 센터 월 구독료(정기결제) 설계용 순수 타입·규칙 — ⚠ 비활성, 어디에도 연결되지 않았다(실제 빌링 호출·빌링키 발급 없음).
  전제(2026-10-16, 사용자 결정): 신규 PG는 NICEPAY. 기존 Toss 빌링키(center_subscriptions.billing_key)는 NICEPAY에서 쓸 수 없다고 본다 —
  전환 시 모든 활성 구독 센터가 NICEPAY에서 카드를 새로 등록해야 한다(기존 구독 상태/이력은 유지, 결제수단만 교체).
  카드번호·유효기간·생년월일·카드 비밀번호는 모하빗 서버/DB가 받지도 저장하지도 않는다. 아래 인터페이스에는 그런 필드가 없다 —
  카드 등록은 NICEPAY가 제공하는 호스팅 방식(기술지원 확인 전까지 BLOCKED)에서 일어나고, 우리는 불투명한 BID(빌링키)만 받는다.
  단건결제 MID와 빌링 MID는 분리한다(NicepayBillingCreds는 일반 결제 creds와 다른 타입).
*/
export const NICEPAY_BILLING_ACTIVATED: boolean = false;
export class BillingNotActivatedError extends Error {
  constructor() { super("NICEPAY 정기결제는 아직 활성화되지 않았어요 (계약·빌링 MID·카드등록 방식 확인 필요)"); this.name = "BillingNotActivatedError"; }
}
export function assertBillingActivated(): void { if (!NICEPAY_BILLING_ACTIVATED) throw new BillingNotActivatedError(); }

export type NicepayBillingCreds = { billingMid: string; billingMerchantKey: string; readonly kind: "billing" };
/** 불투명 빌링키. 로그·화면·에러 메시지에 절대 출력하지 않는다(redactNicepayForLog는 BID를 허용 목록에 두지 않는다). */
export type BillingKeyRef = { readonly bid: string };

export interface NicepayBillingGateway {
  /** 호스팅 카드등록 완료 후 NICEPAY가 돌려준 결과로 BID를 확정한다(카드정보 인자 없음). */
  confirmHostedRegistration(input: { centerId: string; registrationToken: string }): Promise<BillingKeyRef>;
  /** 최초/정기 청구. moid는 회차별 유일값(recurringMoid), amount는 호출 시점의 플랜 가격을 서버가 조회한 값. */
  charge(input: { key: BillingKeyRef; moid: string; amount: number; goodsName: string }): Promise<{ tid: string; amount: number }>;
  deleteBillingKey(key: BillingKeyRef): Promise<void>;
}

// 같은 회차는 항상 같은 Moid → DB 리스(billing_locked_until)가 뚫려도 PG가 중복 Moid를 거부하게 한다(거부 동작은 기술지원 확인 필요).
export function recurringMoid(centerId: string, nextBillingDate: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(centerId) || !/^\d{4}-\d{2}-\d{2}$/.test(nextBillingDate)) throw new Error("정기결제 주문번호 입력이 올바르지 않아요");
  return `sub-recur-${centerId}-${nextBillingDate}`;
}
export function firstChargeMoid(centerId: string, registeredAtIso: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(centerId) || !/^\d{4}-\d{2}-\d{2}T/.test(registeredAtIso)) throw new Error("정기결제 주문번호 입력이 올바르지 않아요");
  return `sub-first-${centerId}-${registeredAtIso.replace(/\D/g, "").slice(0, 14)}`;
}

// 기존 정책 유지: 하루 1회 재시도, 최대 7회. 카드 자체 문제(재시도 무의미)는 즉시 payment_failed. NICEPAY 비재시도 결과코드 목록은 계약 후 채운다(기본: 모두 재시도 대상).
export const BILLING_MAX_RETRY_COUNT = 7;
export function decideAfterChargeFailure(p: { retryCount: number; nonRetryable: boolean }): { status: "past_due" | "payment_failed"; retryCount: number } {
  const next = p.retryCount + 1;
  if (p.nonRetryable || next >= BILLING_MAX_RETRY_COUNT) return { status: "payment_failed", retryCount: next };
  return { status: "past_due", retryCount: next };
}
