/*
  결제 도메인 경계 — 모하빗에는 서로 다른 두 결제가 있다.
    member_pass         : 회원이 센터 수강권/상품을 사는 결제. 주문(orders) 단위, 주문번호는 UUID. 이 앱의 /api/payments/* 와 nicepay 단건 흐름이 처리한다.
    center_subscription : 센터가 모하빗에 월 구독료를 내는 정기결제. center_subscriptions 단위, 주문번호는 sub-recur-… / sub-first-…(nicepay/billing.ts recurringMoid/firstChargeMoid). 회원 결제 흐름과 데이터·API·정산이 완전히 분리된다.
  두 도메인의 식별자는 서로 다른 형식이라, 한쪽 라우트가 다른 쪽 주문번호를 받으면 PG 호출 전에 거부한다(교차 승인/취소 방지).
*/
export type PaymentDomain = "member_pass" | "center_subscription";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function paymentDomainOfMoid(moid: unknown): PaymentDomain | null {
  if (typeof moid !== "string") return null;
  if (/^sub-(recur|first)-/.test(moid)) return "center_subscription";
  return UUID.test(moid) ? "member_pass" : null;
}
/** 회원 수강권 결제 경로는 회원 주문(UUID)만 받는다. 구독 주문번호/알 수 없는 형식은 거부. */
export const isMemberPassMoid = (moid: unknown): moid is string => paymentDomainOfMoid(moid) === "member_pass";
