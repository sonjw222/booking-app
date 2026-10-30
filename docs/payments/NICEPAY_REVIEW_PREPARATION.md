# NICEPAY PG 카드사 심사 준비 (Batch 1) — 2026-10-16

> **최신 상태 안내(2026-10-30)**: 이 문서의 체크리스트 #7·#8·#9(법적 문구의 PG 표기)는 **수정 완료**, #13(심사용 계정)은 전용 권한 `nicepay_review_access` + P2/P2b 로 대체됨. 최신 대조·승인 계획: `NICEPAY_CARD_REVIEW_FINAL_20261030.md`.

> **갱신(2026-10-16, 사용자 결정): PG는 NICEPAY로 확정, Toss/PortOne은 신규 결제에서 제외.** 이 문서의 "기존 Toss/PortOne 구조 유지" 전제는 `PG_MIGRATION_TOSS_TO_NICEPAY.md`로 대체됨(분류·레거시 보존·법적 문구·빌링 전환). 체크리스트(§1)와 단건 설계(§4)는 그대로 유효.

범위: PG MID/KEY 없이 가능한 점검·설계·오프라인 코드. **실제 NICEPAY 호출, DB 변경, 기능 플래그 변경, 카드정보 수집은 없음.**
근거: 저장소 코드(main `5f1cb2d`) + 공식 문서 `developers.nicepay.co.kr`(인증결제 `/docs/pg/auth/*`, 결제통보 `/docs/pg/add/noti`, 비인증 `/docs/pg/non-auth/*`) 2026-10-16 열람 + `https://mwhabit.com/products` 읽기 전용 열람.
⚠ 문서의 필드·공식은 열람 시점 기준이며 계약 후 기술지원 확인이 필요하다(아래 §5).

## 1. 카드사 심사 체크리스트

| # | 항목 | 상태 | 근거 / 조치 |
|---|---|---|---|
| 1 | 홈페이지 하단 상호 | PASS | `app/page.tsx` 푸터가 `BUSINESS_INFO.companyName`(모하빗) 표시 |
| 2 | 대표자명 | PASS | 푸터 "대표 손장욱" |
| 3 | 사업자등록번호 | PASS | 푸터 589-77-00451 (단일 출처 `lib/businessInfo.ts`) |
| 4 | 사업장 주소 | **NEEDS_WORK (사용자 결정 필요)** | 홈 푸터·/products 푸터에는 **의도적으로 없음**(2026-09-04 사용자 결정, `/legal/business`·구독 화면에만 표시). 카드사/PG가 "홈페이지 하단 주소"를 요구하면 결정을 바꿔야 함 — 이번에 임의 추가하지 않음 |
| 5 | 전화번호 | PASS | 푸터 고객센터 010-6505-8700 |
| 6 | 통신판매업 신고번호 | PASS | 푸터 제2026-성남분당B-0866호 |
| 7 | 환불·취소 정책 | NEEDS_WORK | `/legal/refund` 존재·푸터/결제화면/구독화면 연결 PASS. 단 §4가 "토스페이먼츠"를 특정 명시 → NICEPAY 계약·전환 시 문구 갱신 필요(계약 전 임의 변경 안 함) |
| 8 | 이용약관 | NEEDS_WORK | `/legal/terms` 존재 PASS. 91~92행에 결제대행사를 "토스페이먼츠"로 명시 → 전환 시 갱신 |
| 9 | 개인정보처리방침 | NEEDS_WORK | `/legal/privacy` 존재 PASS. 처리위탁 표(147행)에 토스페이먼츠만 있음 → NICEPAY 위탁 추가는 계약 후 |
| 10 | 회원가입·로그인 | PASS | 기존 기능(`/login`) |
| 11 | 상품 2~3개 이상 노출 | PASS(읽기 전용 확인) | 2026-10-16 `/products` 열람: 승인 센터 2곳, 상품 9개 노출 (A10TION 피겨팀 8개, P3 센터 1개) |
| 12 | 상품명·가격·이용기간·환불조건 | NEEDS_WORK | 상품명·가격·횟수 PASS. **이용기간(유효일수)은 공개 RPC가 반환하지 않아 /products에 없음**(`lib/center.ts` `validDays: null`). 환불조건은 이번에 /products 상단 안내로 정책 링크 추가 |
| 13 | 결제 화면 접근 | NEEDS_WORK | 현재 `PG_CHECKOUT_ENABLED=false` 정책이면 일반 회원에게 PG 결제수단이 안 보임. 심사관 전용 오버라이드(`accounts.pg_checkout_override`)가 기존에 있음(Toss 심사용). NICEPAY 심사용 계정 부여는 **금지 항목이라 하지 않음** |
| 14 | 공개 화면 테스트/격리 데이터 | **NEEDS_WORK (운영 데이터, 사용자 조치)** | `/products`에 **"테스트"(수강권 1회 100원)**, 센터 **"P3 타센터-격리테스트"**의 "P3 타센터전용패스(999회 0원)"가 공개 노출 중. 심사관에게 가짜 상품으로 보일 수 있음 → 운영자가 상품 비공개/판매중지 처리 필요(이번 작업은 DB 미변경) |

## 2. 이미 준비된 기능
- 사업자 정보 단일 출처, 푸터/법적 페이지 4종(약관·개인정보·사업자·환불), 결제 화면의 환불·약관 링크.
- Payment Adapter(`lib/payments/*`), PG 게이트(`PG_CHECKOUT_ENABLED`, 서버 `gateAllows`), 서버 승인 라이프사이클(Toss) — 금액 DB 기준 재검증·보상 취소·멱등.
- 센터 구독 정기결제 구조(Toss 빌링): DB 리스, 회차별 유일 orderId, 7회 재시도 정책, 구독 해지.

## 3. 이번 배치에서 수정한 항목
- `/products` 상단에 비결제 안내 추가(이용기간 확인 위치, 결제수단은 구매 화면, 환불·취소 정책/사업자 정보 링크). PG사명·결제창 흉내·주소 없음. 테스트 `productsPurchaseGuide.test.ts`.
- NICEPAY 서버 모듈(**어디에도 연결되지 않음**): `lib/payments/server/nicepay/{signature,types,redact,api,lifecycle}.ts`, `lib/payments/NicepayPaymentProvider.ts`(전 메서드 throw), 오프라인 테스트 `tests/unit/nicepay.offline.test.ts`.
- 정적 테스트: app/ 및 다른 lib에서 nicepay import 금지, 카드번호·유효기간·생년월일·비밀번호·EncData 필드 금지, `NICEPAY_*` 환경변수 로딩 코드 금지, 팩토리가 `nicepay`를 선택하지 않음.

## 4. 단건결제 설계 (인증결제)

```
주문 생성(DB: orders.pending, provider='nicepay', amount=서버가 상품가로 계산)
→ 결제창 호출(브라우저, nicepay-pgweb.js goPay: MID, Moid=orderId, Amt, GoodsName, ReturnURL, EdiDate, SignData)  ← MID/KEY 필요
→ ReturnURL로 인증결과 POST(AuthResultCode, AuthToken, TxTid, Amt, Signature, NextAppURL, NetCancelURL)
→ [handleNicepayAuthReturn] 서명검증 → 주문·금액 대조 → 서버 승인(NextAppURL) → 응답 검증 → DB 확정
→ 결제 결과 기록 / 앱 복귀
```

| 항목 | 설계 (구현 위치) |
|---|---|
| 서버 측 금액 검증 | 승인 요청에는 **DB 주문 금액만** 사용. 인증결과 Amt·승인응답 Amt 모두 DB 금액과 동일해야 함, 불일치 시 승인 전 거부/승인 후 망취소 (`lifecycle.ts`) |
| 주문번호 중복 방지 | Moid=orderId(UUID, 서버 생성). 취소 요청 Moid는 별도 유일값(`api.ts` `cancelMoid`). DB `orders.id` PK |
| 승인 응답 검증 | ResultCode=3001(카드), `Signature = sha256(TID+MID+Amt+Key)`, TID/Moid/MID/Amt 일치. 하나라도 어긋나면 망취소 |
| 결제 중복 확정 방지 | `claimOrder`(pending→approving 원자 선점)로 동시 승인 차단 + 기존 `confirm_real_payment` 멱등. done이면 승인 호출 없이 성공 반환 |
| 결제 실패·취소 | 인증 실패/승인 거절은 돈 이동 없음 → 주문 pending 복귀(재시도). 승인 응답 유실·5xx·해석 불가는 **결과 불명 → 망취소**. 승인 후 취소는 전액만(`nicepayCancel`, PartialCancelCode=0) |
| 결제 후 앱 복귀 | 기존 Toss `return-token`(서명된 복귀 토큰) 패턴 재사용 설계: ReturnURL 처리 라우트가 승인 후 토큰 포함 리다이렉트 → 앱/웹 복귀. 라우트는 계약 후 구현(BLOCKED) |
| Webhook | 문서상 **서명 검증 없음** → 웹훅 값만으로 확정/취소 금지. `classifyNicepayWebhook`은 DB 대조 후 분류(ignore/confirm_needed/mismatch)만. 수신 라우트는 미구현. 허용 IP(121.133.126.10/11, 211.33.136.39) 확인은 Vercel에서 신뢰 가능한 소스 IP 확보 방법을 기술지원에 문의 |
| 로그 | `redactNicepayForLog` 허용 목록: 카드번호·구매자 정보·AuthToken·서명·키·EncData·BID 제외, TID/Moid 뒤 6자리만. 테스트로 보장 |
| SSRF/키 유출 | NextAppURL/NetCancelURL은 공식 호스트(dc1/dc2/pg/webapi.nicepay.co.kr, https:443)만 허용. 아니면 승인 전 거부(토큰 미전송) |

**승인 필요(SQL, 이번에 실행/파일 생성 안 함 — 초안)**
```sql
-- (초안, 미실행) orders.payment_provider에 'nicepay' 허용 + 선점 상태
-- alter table orders drop constraint orders_payment_provider_check;
-- alter table orders add constraint orders_payment_provider_check
--   check (payment_provider is null or payment_provider in ('mock','toss','portone','nicepay'));
-- orders.status에 'approving' 허용 또는 별도 claim 컬럼(pg_claimed_at) + pg_order_context/confirm_real_payment가 provider='nicepay'를 받도록 수정
-- 정산 뷰(fix_admin_settlement_summary_use_payment_provider.sql): payment_provider in ('toss','portone') → 'nicepay' 포함
```
현 `lifecycle.ts`(Toss)의 `PG_PROVIDERS`·`ctx.provider !== "toss"` 검사와 DB RPC 3종도 provider 확장이 필요하므로 DB와 함께 별도 승인 후 진행.

## 5. 정기결제(빌링) 설계 — 구현 없음 (BLOCKED 기록)

공식 문서(비인증 결제, `/docs/pg/non-auth/*`) 확인 결과:
- 빌키 발급(`billing_regist.jsp`)은 **가맹점이 카드번호·유효기간(·생년월일/사업자번호·비밀번호 앞 2자리)을 직접 받아 AES128로 암호화해 전송**하는 방식이며, 문서가 "가맹점이 직접 입력받아 외부 노출 주의"를 경고한다. 즉 카드정보가 가맹점 서버를 통과(PCI-DSS 부담).
- 문서에는 NICEPAY가 제공하는 **카드등록 전용 UI(Toss `requestBillingAuth` 같은 호스팅 방식)가 확인되지 않음**.
- 별도 빌링 MID 필요 여부는 문서에 없음(영업 담당 확인).

→ **이번 작업은 카드번호 등을 받는 코드를 구현하지 않는다.** 정적 테스트가 해당 필드(CardPw/ExpYear/ExpMonth/IDNo/EncData/`CardNo=`) 도입을 막는다.

설계 골격(계약·호스팅 카드등록 확인 후):
| 항목 | 설계 |
|---|---|
| 빌링 MID/키 | 일반 결제와 분리된 환경변수(예: Toss의 `TOSS_BILLING_SECRET_KEY` 분리 패턴과 동일) — 키 로딩 코드는 아직 없음 |
| 카드 등록 | NICEPAY 호스팅 등록창/보안 인증 방식 확인 전까지 **BLOCKED**. 우리 서버는 BID(빌링키)만 받아 `center_subscriptions.billing_key`에 저장(BID는 로그 금지) |
| 최초 결제 | 등록 직후 1회 승인(기존 `app/api/billing/confirm`과 같은 책임), 금액은 `subscription_plans.monthly_price`를 서버가 조회 |
| 매월 청구 | 기존 `charge-due` 구조 재사용: DB 리스 선점 + 회차별 유일 Moid(`sub-recur-{centerId}-{next_billing_date}`) |
| 실패 재시도 | 기존 7회/일, 카드 자체 문제 코드는 즉시 `payment_failed`(NICEPAY 결과코드 표 `/docs/pg/result-code/intro` 기반 비재시도 목록은 계약 후 작성) |
| 해지 | 기존 `centerCancelOwnSubscription` 유지 + 해지 시 빌키 삭제 API(`billkey-remove`) 호출(계약 후) |
| 카드 변경 | 새 BID 발급→성공 후 교체, 구 BID 삭제. 교체 중 이중 청구 방지를 위해 리스 보유 |
| 중복 청구 방지 | 위 DB 리스 + 유일 Moid + (NICEPAY가 Moid 중복을 거부하는지 확인 필요) |

기존 Toss 빌링 코드·`center_subscriptions` 데이터는 변경하지 않았다.

## 6. NICEPAY MID/KEY가 필요한 항목
결제창 호출(SignData 생성·goPay), ReturnURL 승인 라우트 활성화, 승인/망취소/취소 실제 호출, 웹훅 수신 라우트, 빌링 전체, 심사용 결제 테스트(테스트 MID), `NICEPAY_*` 환경변수 도입.

## 7. 나이스 기술지원에 확인할 사항
1. **연동 규격 선택**: 문서의 MID+MerchantKey 방식(인증결제 v3 `nicepay-pgweb.js`)과 신규 REST(Server 승인 `clientId/secretKey`) 중 신규 가맹점에 권장되는 쪽.
2. 금액 필드 형식: 12자리 0패딩 필요 여부(예시 `000000001000`), 서명 계산 시 패딩 포함 여부.
3. **정기결제 호스팅 카드등록 UI/보안 인증 제공 여부** — 카드번호를 가맹점 서버가 받지 않는 방식이 있는지, 빌링 전용 MID 필요 여부, IDNo/CardPw 필수 여부(계약별).
4. 웹훅 위·변조 검증 수단(서명/IP/재조회 API) 및 Vercel(서버리스)에서 허용 IP를 검증하는 권장 방법, HTTPS 웹훅 응답 규격.
5. 결제 상태 조회 API(승인 불명·웹훅 유실 시 재조회용)와 망취소 가능 시간 제한.
6. 심사용 테스트 MID/테스트 카드, 앱(Capacitor WebView)에서의 결제창·앱카드 복귀(Universal Link) 지원 방식.
7. 카드사 심사에서 홈페이지 하단 **사업장 주소 표기 필수 여부**(사용자 결정과 충돌 시 판단 필요).
8. 환불 정책 문구에 PG사명 표기 요건, 개인정보 처리위탁 고지 문구.
9. 비재시도 오류 결과코드 목록(카드 정지·한도 등) 및 Moid 중복 거부 동작.

## 8. 사용자 조치가 필요한 운영 이슈 (코드로 처리하지 않음)
- 공개 `/products`의 "테스트"(100원), "P3 타센터-격리테스트 / P3 타센터전용패스(999회 0원)" 노출 → 심사 전 비공개 처리 권장.
- 이용기간(유효일수) 공개 노출 필요 시 `fetch_public_storefront_products` RPC가 `valid_days`를 반환하도록 **SQL 변경 필요(승인 후)**.
- 약관·환불정책·개인정보 처리위탁의 PG사 표기는 NICEPAY 계약 확정 후 갱신.
