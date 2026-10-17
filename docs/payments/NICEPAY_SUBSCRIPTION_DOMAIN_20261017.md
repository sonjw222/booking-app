# 센터 구독료 결제 도메인 설계 (회원 수강권 결제와 분리) — 2026-10-17

> 활성화하지 않는다. 실제 정기결제 API는 NICEPAY 계약에서 **지원이 확인된 방식만** 구현한다. 코드 경계: `lib/payments/domains.ts`(주문번호 형식으로 도메인 판별·교차 호출 차단), `lib/payments/server/nicepay/billing.ts`(비활성 타입/규칙).

## 1. 두 결제 도메인
| | 회원 수강권(member_pass) | 센터 구독료(center_subscription) |
|---|---|---|
| 결제 주체 / 대상 | 회원 → 센터(모하빗은 중개) | 센터 → 모하빗(모하빗 자체 매출) |
| 식별자 | `orders.id` (UUID) | `center_subscriptions` + 회차 주문번호 `sub-first-…`/`sub-recur-…` |
| 방식 | 단건 인증결제(결제창) | 정기결제(빌링키 BID) + 호스팅 카드등록 |
| 서버 경로 | `/api/payments/nicepay/*`, `/api/payments/refund` | `/api/billing/*`(기존 Toss 빌링 → 전환 대상) |
| DB | orders / payments / nicepay_* | center_subscriptions / 구독 결제 이력(기존) |
| MID/키 | 단건 MID(또는 clientId) | **빌링 전용 MID/키(분리)** — 계약 시 별도 발급 여부 확인 |
교차 방지: 회원 결제 핸들러는 UUID 주문번호만 받는다(`isMemberPassMoid`). 구독 주문번호가 들어오면 PG/DB 호출 전에 거부(테스트 포함).

## 2. 구독 상태 기계(기존 `center_subscriptions`와 호환)
`trialing → active → past_due(재시도 최대 7회/일 1회) → payment_failed → canceled` / 해지 예약(`cancel_at_period_end`) / 재활성화(결제수단 재등록 후).
- **결제 실패**: 카드 자체 문제 코드는 즉시 `payment_failed`, 그 외 `past_due`로 하루 1회 재시도(`decideAfterChargeFailure`, 비재시도 결과코드 표는 계약 후 NICEPAY 결과코드표로 작성).
- **재시도 안전**: 같은 회차는 항상 같은 주문번호(`recurringMoid`)라 DB 리스(`billing_locked_until`)가 뚫려도 PG가 중복 Moid를 거부하는지 확인(계약 후 질문).
- **해지**: 기간 만료까지 유지, 이후 청구 중단 + 빌링키 삭제(`deleteBillingKey`), 삭제 실패는 운영 알림(재청구 방지를 위해 DB에서 먼저 `active` 해제).
- **영수증**: PG 매출전표 URL(`receiptUrl`)을 저장하고, 사업자 세금계산서/현금영수증은 별도 절차(계약 후 확인).
- **결제수단 변경**: 호스팅 등록창으로 새 BID 발급 → 새 BID로 시험 청구 없이 교체(미결제 회차가 있으면 즉시 재시도) → 이전 BID 삭제. 카드번호·유효기간·생년월일·비밀번호는 모하빗 서버/DB가 받지도 저장하지도 않는다(타입에 필드 없음, 정적 테스트).
- **Toss → NICEPAY 전환**: 기존 Toss 빌링키는 NICEPAY에서 쓸 수 없다 → 모든 활성 구독 센터가 카드를 새로 등록해야 한다. 전환 유예 기간 동안 기존 구독 상태/이력은 유지하고 결제수단만 교체.

## 3. BLOCKED(계약·기술지원 확인 필요)
호스팅 카드등록 UI 제공 여부(문서에서 확인되지 않음 — 카드정보 직접 수집은 금지), 빌링 API 규격, 빌링 MID 분리, 비재시도 결과코드, 중복 Moid 처리, 정기결제 취소/부분환불, 세금계산서.

## 4. Apple / Google 앱스토어 정책 검토(별도 보고 — 법무/스토어 심사 확인 필요)
- 센터 구독료는 **B2B 소프트웨어 이용료**(센터 운영자가 사업장 업무에 쓰는 서비스)이고 앱 안에서 "디지털 서비스 구독"으로 노출·결제하면 **App Store Review Guideline 3.1.1(앱 내 구매) / 3.1.3(c) Enterprise Services·3.1.3(b) Multiplatform Services** 해석이 쟁점이다. 외부 결제 안내·링크는 지역/시점별 정책이 계속 바뀌므로 **출시 전 최신 가이드라인과 대상 국가(한국: 앱 내 결제 외 결제 수단 허용 규정) 확인이 필요**하다.
- 안전한 기본안: 구독 결제 화면은 **웹(관리자 웹 `/manager/...`)에서만** 제공하고, 앱(iOS/Android) 안에서는 상태 확인·알림만(결제 CTA/가격 노출 금지). 회원이 센터에서 사는 수강권(실물에 준하는 오프라인 서비스 이용권)은 앱 내 결제 대상이 아닌 "물리적 서비스" 범주로 보지만 이것도 심사 시 설명이 필요하다.
- Google Play: 앱 내 디지털 상품 판매는 Play 결제 요구(예외 범주 확인 필요). 위와 같은 웹 전용 결제로 분리하면 회피가 아니라 "앱에서 판매하지 않음"으로 정리된다.
- 결론: 이 문서는 법률 자문이 아니다. 계약·출시 전 스토어 심사 담당/법무 확인 항목으로 `docs/TODO.md`에 등재.
