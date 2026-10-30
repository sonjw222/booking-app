/*
  법적 고지(약관·환불·개인정보 처리위탁·사업자 정보)에 쓰는 결제대행사(PG) 표기 — 단일 출처.
  - current: 신규 온라인 카드 결제의 결제대행사. 코드상 NICEPAY v3(lib/payments/*)가 신규 PG 이고, 결제창은 NICEPAY_CHECKOUT_ACTIVATED(코드 상수)·DB 게이트(off)가 켜질 때까지 일반 회원에게 열리지 않는다.
  - legacy: 과거 토스페이먼츠로 결제된 거래의 조회·취소·환불은 서버 라우트(app/api/payments/*, lib/payments/server/toss.ts)가 계속 지원한다(신규 Toss 결제는 불가).
  ⚠ 여기 적는 것은 "서비스 이름"뿐이다. NICEPAY 의 정식 상호·소재지·위탁 항목·보유 기간은 계약서(전자계약) 기준으로 사용자가 확인한 뒤에만 법적 고지에 구체화한다(docs/payments/NICEPAY_CARD_REVIEW_FINAL_20261030.md §2).
*/
export const PAYMENT_GATEWAY_NAMES = { current: "NICEPAY", legacy: "토스페이먼츠" } as const;
