# NICEPAY 계약 전 구현 완료 현황 + 계약 후 인수인계 — 2026-10-17

기준: 브랜치 `feat/nicepay-review-preparation-20261016`, 이전 기준 커밋 `f573fff`. 실제 결제는 비활성(코드 상수 `NICEPAY_CHECKOUT_ACTIVATED=false`). 운영 DB 적용 완료: `fix_refund_pg_origin_guard`, `fix_refund_server_path_fail_closed`, `fix_refund_amount_integrity`(2026-10-17).

## 1. 구현 상태
### 구현 완료 (계약 없이 가능한 것 전부)
| 영역 | 내용 | 위치 |
|---|---|---|
| 규격 분석 | REST(v1)/v3(MID) 두 계열·Server/Client 승인 모델·취소·망취소·조회·웹훅·WebView | `NICEPAY_SPEC_ANALYSIS_20261017.md` |
| 설정·플래그 | 4중 잠금(코드 상수·`NICEPAY_CHECKOUT_ENABLED`·`NICEPAY_API_FAMILY`·키/URL). Toss 플래그와 분리. 설정 불완전 → 503/501 | `server/nicepay/config.ts`, `runtime.ts` |
| REST(v1) 연동 | 서명 5종, 승인/망취소/취소/조회/주문번호 조회, Basic 인증, 호스트 허용 목록, 30초 타임아웃, 서명 검증된 응답만 신뢰 | `server/nicepay/rest.ts` |
| 구매 흐름 | 준비(prepare) → 결제창(SDK) → returnUrl 승인 → 결과 화면. 성공은 DB 상태 `done`일 때만 | `flow.ts`, `restLifecycle.ts`, `app/api/payments/nicepay/*`, `app/checkout/nicepay/result` |
| 장애 복구 | 승인 불명→망취소, 승인 후 DB 실패→취소+조회+취소 기록, 응답 유실 멱등, 중복·동시 승인, 승인 중 취소 경합, 확정 불명→review | `restLifecycle.ts` |
| 환불 | PG 취소 → 조회 재확인 → 취소 기록 → 내부 환불. 불명은 환불 표시 유지. 금액=원거래 전액 | `refund.ts`, `lifecycle.ts`(핸들러 주입) |
| 불명확 거래 조사 | 주문번호 조회 → 확정/취소/해소 후보 권고(읽기 전용, 자동 확정 없음) | `recovery.ts` |
| 클라이언트 | `NicepayPaymentProvider`(REST SDK 결제창, 서버가 만든 파라미터만 사용), 결과 폴링 API | `lib/payments/NicepayPaymentProvider.ts`, `nicepayClientApi.ts` |
| 도메인 분리 | 회원 수강권 ↔ 센터 구독료 주문번호 교차 차단, 구독 설계 | `lib/payments/domains.ts`, `NICEPAY_SUBSCRIPTION_DOMAIN_20261017.md` |
| SQL | orders INSERT 서버 전용 필드 보정의 anon/authenticated 롤 경계(+rollback/verify), preflight 점검 추가 | `fix_orders_insert_role_guard_20261017.sql` 등 |
| 보안 전수 점검 | 권한 diff(실제 PG), 롤/RLS 실측, SECURITY DEFINER·search_path·RLS·서버 전용 테이블 | 실제 PG 테스트 R15~R17 |

### 미완료 (계약 정보 없이는 진행 불가 = BLOCKED)
| 항목 | 이유 |
|---|---|
| 실제 NICEPAY 호출/샌드박스 E2E | 키·MID 없음, 실제 PG 호출 금지 |
| v3(MID) 결제창 클라이언트(`nicepay-pgweb.js goPay`)·v3 거래 조회·v3 취소 URL 확정 | 어떤 키 계열이 발급될지 모름(v3 취소 URL `NICEPAY_V3_CANCEL_URL`은 가정값) |
| Client 승인 모델/승인금액 검증 API(`isValid`) | 명세가 확인한 문서에 없음, 채택하지 않음 |
| 취소 응답 서명 공식, 이미 취소된 거래 재요청 응답, 멱등성, `ediDate` 정확한 포맷, 주문번호 조회 `signData` | 문서 미기재 — 조회 재확인으로 대체, 샌드박스에서 확인 필요 |
| 모바일 WebView `appScheme`/Universal Link, 외부 브라우저 복귀 실측 | 기술지원 확인 + 실기기 필요 |
| 웹훅 수신 도메인/IP 등록, 운영자 도구(콘솔 취소 기록 입력 UI) | 운영 등록·계약 필요 / 별도 승인 범위 |
| 정기결제(빌링) 실제 API | 계약에서 지원 방식 확인 후(호스팅 카드등록 UI 확인 전까지 금지) |
| 코드 상수 `NICEPAY_CHECKOUT_ACTIVATED=true` | 샌드박스 E2E 통과 + 별도 승인 후 |

## 2. 상태 전이(주문)
`pending` →(claim) `approving` →(승인 검증 + 승인 기록 + 확정) `paid→done`. 복귀: `approving → pending`(승인 거절 `approve_rejected` / 망취소·일반취소 확인 `netcancel_confirmed`). 불명: `approving`+`pg_review_*`(운영자 확인). 취소: `pending → cancelled`만(승인 진행 중 취소는 DB 트리거가 거부).

## 3. 장애 상황 → 동작 → 테스트
| 상황 | 동작 | 테스트 |
|---|---|---|
| 승인 요청 중 네트워크 끊김/5xx/해석 불가 | 망취소 → release, 실패면 review(approving 유지) | `nicepay.rest.flow` 장애 복구, 실제 PG 라이프사이클 |
| PG 승인 후 DB 확정 실패 | 일반 취소 → 조회 재확인 → 취소 기록 → release, 확인 불가면 review | 동 |
| DB 확정 성공 후 응답 유실 | 재조회 done이면 취소 없이 성공, 재요청 멱등(수강권 1개) | 동 |
| 중복 클릭/동시 동일 주문 승인 | claim 직렬화: 승인 1번, 한쪽 409 | 가짜 DB + 실제 PG 동시 2건 |
| 승인 중 사용자의 주문 취소 | pending만 취소, approving이면 409 | `abandon`, SQL 트리거 |
| 브라우저 종료/결제창 복귀 실패 | approving 유지 → status 폴링/주문번호 조회 권고/`nicepay_expire_stale_claims`(기존 SQL) | `recovery`, status |
| 망취소 실패 | review + 재승인 차단 | 동 |
| 환불 성공 후 DB 기록 실패 | 환불 표시 유지, 같은 요청 재시도로 이어서 완료(환불 행 1개) | `refund`, 실제 PG |
| 이미 취소된 거래의 재요청 | 응답 코드에 의존하지 않고 조회로 취소 확인 후 이어서 | `refund` |
| 불명확한 거래 | 자동 성공/실패 처리 없음, 운영자 확인 | review·recovery |

## 4. 보안 항목(C) → 근거
1 사용자 인증: Bearer 또는 주문 전용 복귀 토큰(HMAC, 15분) / 2 소유권: `pg_order_context(uid)` / 3 DB 금액: 승인 요청·준비 파라미터·취소 모두 DB 주문 금액, 인증/승인 응답 금액 대조 / 4 MID·주문번호: clientId/MID·orderId 대조, UUID만 허용 / 5 위변조: 인증·승인 응답·조회·웹훅 서명(상수 시간 비교) / 6 거래번호 중복: `nicepay_pg_approvals.tid` 유일 + `orders.pg_tid` 유일 / 7 중복 승인: claim 원자 선점 / 8 중복 발급: `confirm_nicepay_payment` 멱등 + 결제 행 사후 검증 / 9 취소 경합: 트리거 + release 가드 / 10 클라이언트 임의 완료: 클라이언트가 완료를 선언할 경로 없음(status는 DB만, `confirm_*`는 service_role 전용) / 11 비밀 노출: 키는 `config.ts`에서만 읽고 응답·로그·`NEXT_PUBLIC_`에 없음(정적 테스트) / 12 service_role RPC: 모든 신규 함수 SECURITY DEFINER + search_path 고정 + client EXECUTE 없음(권한 diff 테스트).

## 5. SQL (실행 필요: YES — 운영·DEV 어디에도 실행하지 않음)
적용 순서(미적용분): 0 `preflight_nicepay_patch_targets_20261016.sql`(읽기 전용, `orders_insert_guard_patch_ok` 포함) → 1 `fix_orders_insert_role_guard_20261017.sql`(독립 적용 가능) → 2 `add_nicepay_provider_support_20261016.sql` → 3 `fix_create_order_secure_allow_nicepay_20261016.sql` → 4 각 `verify_*`.
롤백(역순): `rollback_fix_create_order_secure_allow_nicepay` → `rollback_add_nicepay_provider_support` → `rollback_fix_orders_insert_role_guard`.

## 6. 계약 시 확인할 질문
1. 발급되는 키 유형은? **REST(v1) clientId/secretKey인가, v3 MID/MerchantKey인가?** Server 승인 모델 키로 발급 가능한가(Client 승인 모델 키는 사용하지 않음)?
2. 샌드박스 계정/키 제공 여부, 샌드박스에서 실제 카드 승인·취소·망취소·웹훅 시험 가능 범위.
3. 취소 응답의 `signature` 공식(문서 미기재). 취소 요청 `orderId`(취소 요청 번호) 재사용(같은 값 재요청) 시 응답/멱등성. **이미 취소된 거래 재요청 응답 코드.**
4. 승인 응답을 못 받았을 때 망취소 대상 조건(승인 전/후, 1시간 제한), `orderId` 유일성 요구 범위(날짜별? 전체?).
5. `ediDate` 정확한 포맷(오프셋/밀리초), 허용 시각 오차. `find/{orderId}`의 `signData` 규칙(문서에 tid 기반으로 적혀 있음).
6. 웹훅: 수신 URL 등록 절차, 재전송 정책, 발신 IP(문서: 121.133.126.86/87 확인), 이벤트 지연 시간, 취소 통보의 `status` 값.
7. 모바일 앱(WebView/외부 브라우저) 결제: `appScheme`/Universal Link 설정, iOS 앱스토어 심사에서의 PG 결제창 허용 방식, 외부 Safari 복귀 시 쿠키/세션 제약.
8. 결제수단 범위(카드/간편결제/계좌이체)와 수수료·정산 주기, 간편결제 사업자별 별도 심사 여부, 할부 옵션.
9. 정기결제: 호스팅 카드등록창 제공 여부, 빌링 MID 분리 여부, 비재시도 결과코드, 중복 Moid 거부 여부, 정기결제 취소/부분환불. (카드정보 직접 수집 금지)
10. 부분취소 지원/정책, 환불 처리 시점(D+1 17:00), 정산 잔액 부족 시 취소 실패 대응, 가상계좌 환불 계좌 처리.
11. 에스크로 필요 여부(통신판매중개 구조), 현금영수증/매출전표(`receiptUrl`) 노출 요건, 운영 전환 절차(도메인 등록·키 교체).
12. 운영 중 장애 연락 채널/SLA, 거래 조회·재전송 관리자 기능(운영자가 콘솔에서 취소한 건을 우리 DB에 반영하는 절차).

## 7. MID/키 발급 후 입력할 환경변수(서버 전용, 값은 저장소 금지)
| 변수 | 설명 |
|---|---|
| `NICEPAY_CHECKOUT_ENABLED` | `"true"`일 때만 서버 경로 활성(코드 상수와 별개로 필요) |
| `NICEPAY_API_FAMILY` | `rest_v1` 또는 `v3_mid` (계약 키 유형) |
| `NICEPAY_ENV` | `sandbox` / `production` |
| `NICEPAY_RETURN_BASE_URL` | 예 `https://mwhabit.com` (https, 경로 없음) |
| `NICEPAY_CLIENT_ID`, `NICEPAY_SECRET_KEY` | rest_v1 |
| `NICEPAY_MID`, `NICEPAY_MERCHANT_KEY` | v3_mid |
| `PAYMENT_RETURN_TOKEN_SECRET` | 기존 변수(복귀 토큰 서명) — NICEPAY 활성에도 필수 |
| `SUPABASE_SERVICE_ROLE_KEY` | 기존 변수(서버 RPC) |
기존 `NEXT_PUBLIC_PAYMENT_PROVIDER=nicepay`(클라이언트 결제창 노출), `NEXT_PUBLIC_PG_CHECKOUT_ENABLED=true`(일반 회원 노출; 아니면 심사 계정 override만)는 **별개**의 노출 설정이다. 코드 상수 `NICEPAY_CHECKOUT_ACTIVATED`는 코드 변경으로만 켠다.

## 8. 운영 활성화 전 QA 체크리스트
- [ ] SQL 적용 순서대로(위 §5) 실행 후 verify 전부 true, preflight `*_ok` 전부 true
- [ ] 샌드박스: 정상 승인 → 수강권 1개 발급 → 예약 가능(상태 done 전에는 구매 성공 표시 없음)
- [ ] 샌드박스: 승인 거부(한도 초과 등) → 주문 pending 복귀, 재시도 성공
- [ ] 샌드박스: 금액 위변조·서명 위조·타인 주문·만료 토큰 → 승인 호출 없이 거부
- [ ] 샌드박스: 승인 응답 유실 모사(네트워크 차단) → 망취소 → 거래 cancelled, 수강권 없음
- [ ] 샌드박스: 환불 → PG 취소 확인 → 취소 기록 금액=환불 금액=원거래 금액, 같은 환불 동시 요청 1건만
- [ ] 이미 취소된 거래의 환불 재요청이 조회 재확인으로 이어서 완료되는지, 문서 미기재 응답 코드 실측 기록
- [ ] 웹훅 수신(서명 검증, `OK` 응답, IP 허용), 웹훅만으로 상태가 바뀌지 않음
- [ ] iOS/Android 앱·모바일 웹 결제창 복귀(내장 WebView·외부 Safari 모두), 앱 종료 후 재진입 시 결과 확인
- [ ] 직접결제·Toss(과거 거래 환불)·PortOne·Mock 회귀, 일반 회원에게 NICEPAY 비노출(플래그 OFF), 심사 계정만 노출
- [ ] 로그/응답에 키·토큰·카드정보 없음, `NEXT_PUBLIC_`에 NICEPAY 비밀 없음
- [ ] 불명확 거래 운영 절차 리허설(`recovery.ts` 권고 → `nicepay_confirm_reviewed`/`nicepay_resolve_review` 2인 승인)
- [ ] 법적 문구(환불정책·개인정보 처리위탁) NICEPAY로 갱신, 사업자 정보 푸터, 100원 심사 상품 공개 정리(운영자)
- [ ] 마지막: `NICEPAY_CHECKOUT_ACTIVATED=true` 코드 변경 PR 리뷰 → 소수 계정(override)으로 운영 소액 검증 → 일반 노출(`NEXT_PUBLIC_PG_CHECKOUT_ENABLED`)

## 9. 계약 후 이어서 실행할 Claude Code 프롬프트
```
모하빗 NICEPAY 계약 후 활성화 준비 — 저장소 sonjw222/booking-app, 브랜치 feat/nicepay-review-preparation-20261016에서 시작(먼저 git status/최신 커밋 확인).
계약 결과: 키 유형 = <rest_v1 | v3_mid>, Server 승인 모델 여부 = <...>, 샌드박스 clientId/MID는 환경변수로만(코드/문서/로그에 값 금지).
읽을 문서: docs/payments/NICEPAY_SPEC_ANALYSIS_20261017.md, NICEPAY_CONTRACT_HANDOFF_20261017.md(§1 BLOCKED, §6 질문 답변 반영).
할 일: (1) 계약 답변으로 BLOCKED 항목을 갱신 — 취소 응답 서명 공식, 이미 취소된 거래 재요청 응답, ediDate 포맷, find/{orderId} signData, 웹훅 필드(status 값), appScheme.
(2) v3_mid 계열이면 v3 결제창 클라이언트(NicepayPaymentProvider)와 v3 취소 URL/조회를 구현, rest_v1이면 rest.ts의 가정값을 샌드박스 실측으로 확정(가정 → 확인으로 주석 갱신).
(3) 샌드박스 환경에서만(실제 운영 키 금지) 가짜 PG 테스트와 같은 시나리오를 실제 샌드박스로 재현하는 스모크 스크립트 작성(정상/거부/위변조/망취소/환불/웹훅). 실제 돈이 움직이는 호출 금지.
(4) 결과로 테스트·문서를 갱신하고 SQL이 더 필요하면 검토용 SQL+rollback+verify만 작성(운영/DEV 실행 금지).
(5) NICEPAY_CHECKOUT_ACTIVATED를 true로 바꾸는 것은 하지 말고 "활성화 PR 초안"과 체크리스트(§8) 결과만 보고.
금지: 운영/DEV SQL 실행, 운영 환경변수 변경, 운영 결제, Push/PR/병합(요청 전), A10TION 100원 상품 변경.
최종 보고: 변경 파일, 커밋 SHA, SQL 필요 여부/경로/순서/전문, 롤백, 검증 방법, 테스트 결과, BLOCKED 항목.
```
