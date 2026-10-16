# PG 전환 계획: Toss → NICEPAY (사용자 결정 2026-10-16)

결정: **신규 PG = NICEPAY 단독.** 토스페이먼츠 PG·PortOne은 신규 결제에서 제외. 직접결제(센터 현장)·`PG_CHECKOUT_ENABLED=false` 정책·`BILLING_ENABLED`/`PAYOUTS_ENABLED` 기본 꺼짐은 유지.
상태: 계약 체결·MID 발급·카드사 승인 **미완료** → 실제 PG 결제·빌링은 계속 비활성(코드 잠금 + 환경 플래그 이중). 선행 문서: `NICEPAY_REVIEW_PREPARATION.md`(체크리스트·단건 설계·질문 목록).
Toss 운영 키·Vercel 환경변수·DB·기존 결제/주문/수강권 기록은 이번 작업에서 변경/삭제하지 않았다.

## 1. Toss 의존성 분류

| 유형 | 파일 | 처리 |
|---|---|---|
| **A. 단건결제 전용** | `lib/payments/TossPaymentProvider.ts`(삭제), `lib/payments/PortOnePaymentProvider.ts`(삭제), `tossPaymentApi.ts`의 `confirmRealPaymentApi`·`cancelRealPaymentApi`(삭제), checkout의 `loadTossSdk` 예열·`TOSS_SUPPORTED_METHODS`(→`PG_SUPPORTED_METHODS`), `app/api/payments/confirm`·`cancel` 라우트 | 신규 경로에서 제거 완료. **라우트는 보류**(아래 §2: 진행 중 결제·재조회 대비). Factory는 `mock｜nicepay｜disabled`로 개편 |
| **B. 정기결제 전용** | `lib/centerSubscription.ts`(`requestCenterBillingAuth`, `confirmCenterBilling`, `tossCustomerKeyForCenter`), `lib/tossSdk.ts`(빌링만 사용), `app/api/billing/confirm`·`charge-due`, `app/manager/subscription/page.tsx` 카드등록 UI, SQL `add_center_subscription_recurring_billing.sql` 등 | **보류(레거시)**: `BILLING_ENABLED`가 꺼져 있고 기존 Toss 빌링키 구독 데이터가 있을 수 있어 코드를 지우지 않음. NICEPAY 전환 설계는 §4. 빌링 코드는 NICEPAY 빌링 활성화 시점에 교체 |
| **C. 지급대행 전용** | `lib/payouts.ts`, `center_payout_accounts`, `manager/settlement`의 "Toss 지급대행(준비 중)" 섹션 | **활성화하지 않음·별도 검토**(PAYOUTS 꺼짐 유지). NICEPAY의 정산/지급 서비스가 있는지 기술지원 확인 필요. 화면 문구 정리는 정산 구조 결정 후 |
| **D. TossPay 간편결제** | `checkout`·`cart`·`center-info`의 `toss`(토스페이) 결제수단 id, `EASY_PAY_BY_METHOD`, `--vendor-toss` | **유지(수단 id)**. NICEPAY가 토스페이/카카오페이를 결제창에서 제공하는지는 기술지원 확인 전까지 미정 — 미지원이면 `HIDDEN_PAY_METHOD_IDS`에 id 추가로 숨김(메커니즘 이미 있음). `EASY_PAY_BY_METHOD` 값은 Toss 규격 → NICEPAY 연동 시 교체 |
| **E. 과거 거래 조회·취소·환불** | `lib/payments/server/{lifecycle,toss,deps}.ts`, `app/api/payments/{refund,return/confirm,return/cancel,return-token}`, `app/checkout/success|fail`, `lib/payments/returnApi.ts`, `tossPaymentApi.ts`의 `refundMembershipApi`·`requestReturnToken`, DB RPC(`pg_*`, `confirm_real_payment`, `refund_membership_server`), SQL 기록, `orders.payment_provider IN ('toss','portone')` 정산 뷰 | **전부 보존**(테스트 `pgMigrationToNicepay.test.ts`가 존재·핵심 계약을 고정). 환불은 `provider==='toss'`일 때 토스 취소 후 DB 환불, `portone`>0은 fail-closed |
| **F. 공통(재사용)** | `PaymentService`, `types.ts`, 주문 생성/상태 전환(`lib/orders.ts`), `returnApi`(대기 주문 marker), 복귀 토큰(`return-token` 패턴), `maskKey`/로그 규칙, 금액 서버 재검증·보상 취소·멱등 구조 | 최대한 재사용. NICEPAY 라이프사이클(`server/nicepay/lifecycle.ts`)은 같은 원칙으로 구현됨. 복귀 토큰 라우트가 `provider==='toss'` 전제라 NICEPAY용 일반화 필요(SQL/라우트 변경 시 함께) |

### 이번에 실제로 바꾼 것
- `PaymentProviderFactory`: `mock｜nicepay｜disabled`. 환경변수 `toss`/`portone`은 `disabled`(**mock으로 조용히 폴백하지 않고** 모든 결제 호출 거부). `nicepay`는 `NicepayPaymentProvider`(전부 throw) + 코드 잠금 `NICEPAY_CHECKOUT_ACTIVATED=false`.
- checkout: `createOrder`(포인트 차감 포함) **이전에** `mock`이 아니고 `isOnlinePgCheckoutAvailable()`이 아니면 "온라인 결제는 준비 중" 안내 후 중단. 직접결제 분기는 그 앞에서 처리되므로 영향 없음. 신규 주문 provider 타입은 `mock｜nicepay`.
- 삭제: Toss/PortOne 클라이언트 Provider와 해당 테스트, 미사용 클라이언트 래퍼. 정적 테스트 7곳을 새 구조에 맞게 갱신(Toss 서버 경로 단언은 그대로).
- 운영 키/Vercel 환경변수/DB/기존 기록: 변경 없음. 배포 환경에 `NEXT_PUBLIC_PAYMENT_PROVIDER=toss`가 남아 있어도 이제 `disabled`(결제 거부)로 동작한다 — PG 게이트가 꺼져 있어 일반 회원 영향은 없으나, 심사용 override 계정의 Toss 결제는 더 이상 열리지 않는다(의도).

## 2. 보류 중인 레거시 정리 (승인 후)
- `app/api/payments/confirm`·`cancel` 라우트와 `confirmForAuthorizedUid`: 신규 Toss 주문은 생기지 않지만, 전환 시점에 결제창이 열려 있던 주문의 승인/복구가 이 경로를 쓴다. 전환 완료 후 `pending`·`provider='toss'` 주문이 0건임을 **읽기 전용으로 확인한 뒤** 제거 승인 요청.
- Toss 빌링(B): 활성 구독 센터가 NICEPAY로 카드 재등록을 마친 뒤 제거.
- `lib/tossSdk.ts`는 빌링이 쓰므로 B와 함께 제거.

## 3. 단건결제 보완 (Batch 1 설계에 추가)
| 요구 | 상태 |
|---|---|
| 서버 금액 검증 / 주문 ID 중복 방지 / 승인 멱등 / 웹훅 중복 / 승인 후 DB 실패 보상 | 구현·테스트됨(`server/nicepay/lifecycle.ts`, 36개). 웹훅 중복은 DB 대조 분류로 멱등(상태 변경 없음) |
| 부분취소 | **미구현·불필요 판단**: 현재 환불은 수강권 전체 환불(`refund_membership_server`)만 있다. 부분취소는 API 규격(`PartialCancelCode=1`, `RemainAmt`)을 문서화만 했고, 도입 시 Moid 유일성·잔액 추적 컬럼(SQL)이 필요 → 승인 대상 |
| 승인 결과 재조회·복구 | 승인 불명은 망취소로 정리. **거래 조회 API가 공식 문서에서 확인되지 않아 BLOCKED**(기술지원 질문 5번). 확인 전까지 웹훅·운영자 확인으로 대체 |
| 회원·센터·상품 소유권 | 주문 생성 시 RPC가 본인 프로필/센터/상품을 확인(기존). NICEPAY 반환 처리에는 사용자 세션이 없으므로 서명 검증(MerchantKey) + DB 주문 대조 + 복귀 토큰(기존 패턴)으로 대체 |
| 결제 실패 시 수강권 미발급 | 발급은 `confirm_real_payment`(DB 확정) 이후에만. 실패 경로는 DB 확정 호출 없음(테스트 고정) |
| 웹/Capacitor 복귀 | 복귀 토큰 패턴 재사용(checkout에서 `providerName==="nicepay"`일 때 토큰 발급 후 marker 저장 — 코드 유지). NICEPAY ReturnURL(POST 수신) 라우트와 앱 복귀 방식은 계약 후 구현 |
| 실제 결제창 | 호출하지 않음. 가짜 결제창으로 심사자를 속이지 않는다 |

## 4. 정기결제(NICEPAY 빌링) 전환 설계 — 구현은 비활성 규칙·타입만
`lib/payments/server/nicepay/billing.ts`(비활성, 연결 없음) + 기존 Toss 빌링 구조 분석:
| 기존(Toss) | NICEPAY 전환 |
|---|---|
| `requestCenterBillingAuth`(Toss 호스팅 카드등록창 → authKey) → `/api/billing/confirm`(authKey→billingKey 교환 + 첫 결제) | **BLOCKED**: NICEPAY 호스팅 등록창 존재 여부 미확인. 비인증 빌키 발급은 가맹점이 카드번호 등을 직접 받는 방식(문서 확인) → 구현하지 않음. 확인되면 `NicepayBillingGateway.confirmHostedRegistration`으로 BID만 받는다 |
| `center_subscriptions.billing_key`(Toss) | **재사용 불가 가정**. 전환 시 센터별 카드 재등록 필요. 기존 구독 상태·이력 컬럼은 유지, 새 컬럼/provider 구분(`billing_provider`)이 필요할 수 있음(SQL 승인) |
| `charge-due` 크론: DB 리스 + `sub-recur-{center}-{date}` | 동일 구조 재사용(`recurringMoid`), 최초 결제는 `firstChargeMoid`. 청구 금액은 매 실행 시점 `subscription_plans.monthly_price` |
| 실패: past_due 최대 7회, 카드 문제 즉시 payment_failed | `decideAfterChargeFailure`로 규칙 고정(비재시도 코드 목록은 계약 후) |
| 해지: 구독 상태 변경 | 유지 + 해지 시 빌키 삭제 API 호출(문서 `billkey-remove`, 계약 후) |
| 카드 변경 | 새 BID 발급 성공 후 교체 → 구 BID 삭제. 교체 중 리스 보유 |
| 단건 MID vs 빌링 MID | `NicepayBillingCreds`(kind: "billing")로 타입 분리, 환경변수도 분리 |
| 키 로딩/실제 호출 | 없음. `NICEPAY_BILLING_ACTIVATED=false`, `assertBillingActivated()` |

## 5. 법적 고지 "토스페이먼츠" 문구 — 수정 대상 분류 (초안만, 페이지 미수정)
| 위치 | 현재 | 분류 | 초안(승인 후 적용) |
|---|---|---|---|
| `app/legal/terms/page.tsx:91-92` | "…결제 대금은 전부 회사의 결제대행사(토스페이먼츠)를 통해…" | **법적 의미 포함 → 사용자 승인 필요** | "결제대행사(주식회사 나이스페이먼츠)"로 교체(상호 표기는 계약서 기준으로 확정) |
| `app/legal/refund/page.tsx:67` | "…결제대행사(토스페이먼츠)를 통해 승인 취소…" | 위와 동일 | 위와 동일 |
| `app/legal/business/page.tsx:44` | "회원의 결제 대금 수납은 모하빗이 결제대행사(토스페이먼츠)를 통해 직접 처리" | **판매 책임 문구와 한 문단 — 승인 필요** | PG명만 교체하되 §6 책임 문구는 건드리지 않음 |
| `app/legal/privacy/page.tsx:147` | 처리위탁 표 "토스페이먼츠 — 온라인 PG 결제 기능 활성화 시…" | 개인정보 위탁 고지 → 승인 필요 | "나이스페이먼츠 — 결제 승인·취소 처리" 행으로 교체(수탁 범위·보유기간은 계약 확인). 계약 전에는 Toss 행을 그대로 두는 것이 사실과 일치 |
| `app/manager/members/page.tsx` | "온라인 결제(Toss)" | 비법적 UI → **수정 완료**("온라인 결제(PG)") | — |
| `manager/settlement`·`admin/settlement` 주석·화면의 "Toss 지급대행", "Toss 가맹점" | 정산 구조 설명 | C 분류 → 정산 구조 결정 후 별도 | — |
| `app/manager/subscription/page.tsx` 주석 | 토스 심사 관련 주석 | 코드 주석(기능 영향 없음) | 빌링 전환 시 정리 |

**적용 시점 주의:** 계약이 끝나 NICEPAY가 실제 PG가 되기 전에 법적 페이지만 먼저 "나이스페이먼츠"로 바꾸면 사실과 달라질 수 있다 → 활성화와 같은 배포로 적용 권장.

### 5-1. 개정 초안 (적용 금지 — 법적 의미 변경 아님, PG명·고지 대상만 교체. 승인 후 활성화와 같은 배포로)
- **terms 91~92행**: "…카드·카카오페이·토스페이·계좌이체 결제의 대금은 전부 회사의 결제대행사(**주식회사 나이스페이먼츠**)를 통해 수납·정산됩니다." (원문의 "수납" 구조·책임 문장은 그대로 두고 PG명만 교체. 계약서상 정확한 상호 확인 필요)
- **refund §4**: "신용카드·카카오페이·토스페이로 결제한 건은 결제대행사(**나이스페이먼츠**)를 통해 승인 취소되고…" (환불 방식·소요일 문장 유지. NICEPAY의 카드 취소/계좌 환불 처리일은 계약 후 확인)
- **business 44행**: "다만 회원의 결제 대금 수납은 모하빗이 결제대행사(**나이스페이먼츠**)를 통해 직접 처리하며…" (판매자·환불 책임 관련 위·아래 문단은 변경하지 않음)
- **privacy 147행 처리위탁 표**: "나이스페이먼츠 | 결제 승인·취소 처리(카드·계좌이체 결제 정보)" — 위탁 범위·보유기간은 NICEPAY 계약/개인정보 처리방침 기준으로 확정. Toss 행은 Toss 결제 이력 환불 처리 기간 동안 유지 여부를 함께 결정.
- 카카오페이/토스페이 문구는 NICEPAY 결제창이 해당 수단을 제공하는지 확인되기 전까지 유지하거나 삭제할지 결정 필요.

## 6. 법적 책임·사업자 정보 (NEEDS_APPROVAL)
- 모하빗은 법적 고지에서 **통신판매중개자**로 설명한다(`/legal/business`). 반면 `manager/settlement` 안내는 "회원 결제는 플랫폼(대표 개인사업자) 명의 가맹점으로 직접 수납되고 센터에 별도 정산"이라 적고 있어, **실제로는 대금을 모하빗이 수납**한다. 나이스는 가맹점(고객사)의 판매·환불 책임을 중요하게 보므로 이 불일치가 심사 질문이 될 수 있다. 나이스 담당자 답변 전에는 문구를 바꾸지 않았다.
- 사업장 주소: 홈 하단 비공개(2026-09-04 결정) 유지. 나이스의 "하단 6개 정보" 요건에 주소가 포함되면 **NEEDS_APPROVAL**(홈 푸터 주소 노출 결정 필요). 현재 푸터는 상호·대표자·사업자번호·통신판매업번호·고객센터 5개 + 법적 링크 4개.
- `lib/businessInfo.ts`는 수정하지 않았다.

## 7. 추가 승인 필요 목록
1. SQL: `orders.payment_provider` 'nicepay' 허용, 선점(claim) 상태, `pg_order_context`·`confirm_real_payment`·`pg_refund_context`·복귀 토큰 라우트의 provider 일반화, 정산 뷰 provider 확장, (빌링) `billing_provider`/BID 컬럼.
2. 법적 문구 4곳 교체(§5), 홈 푸터 주소 노출 여부(§6), 통신판매중개자/수납 구조 설명 정리.
3. 레거시 제거(§2) — `provider='toss'` 대기 주문 0건 확인 후.
4. 계약 후: MID/KEY·환경변수, 결제창 연동, ReturnURL·웹훅 라우트, `NICEPAY_CHECKOUT_ACTIVATED` 해제(리뷰된 코드 변경), 심사용 계정 정책.
5. 기술지원 질문: `NICEPAY_REVIEW_PREPARATION.md` §7 + 토스페이/카카오페이 NICEPAY 결제창 제공 여부, 정산/지급대행 서비스, 거래 조회 API, 빌링 호스팅 등록창, 기존 Toss 빌링키 이전 불가 확인.
