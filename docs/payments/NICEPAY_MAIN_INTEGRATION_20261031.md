# NICEPAY v3 결제창 통합 — 최신 main 기준 통합·격리 브라우저 QA (2026-10-31, 로컬)

브랜치 `feat/nicepay-main-integration-20261031` = `origin/main`(f0df513, 배포 중인 SHA) + `feat/nicepay-review-integrated-20261029`(b555415) 병합 + 통합 QA 에서 발견한 수정. **운영·공유 DEV 변경, 실제 NICEPAY 호출, 결제 활성화, push/PR/병합은 하지 않았다.**

## 1. 충돌 분석(통합 전)
- 두 브랜치의 공통 조상은 ef3faa1. main 은 이후 2커밋(#245·#246: accounts INSERT 보안 수정 + 격리 스택 동기화)만 앞서 있다. 통합 브랜치는 27커밋·429파일(대부분 docs 287·SQL 40·lib/payments 29·scripts 19·테스트).
- **양쪽이 모두 건드린 파일**: `docs/CHANGELOG.md`·`docs/TODO.md`(내용 충돌 — 양쪽 항목 모두 유지), `fix_/rollback_fix_/verify_fix_accounts_insert_privileged_columns_20261030.sql`(main = 운영 적용본 SHA-256 `b8c77b4b…`; 병합 결과가 main 본과 동일 — 통합 브랜치의 옛 초안은 버려짐). 코드 충돌 없음.
- 체크아웃 UI: main 의 `app/checkout/page.tsx` 는 Toss 흐름, 통합 브랜치는 NICEPAY 흐름 — 같은 파일의 다른 부분이라 자동 병합 성공(수동 충돌 없음).
- `PaymentProviderFactory`: **main 은 `nicepay` 를 모르고 미지원 값을 `mock` 으로 처리**(`resolveProviderName`: toss/portone 외에는 모두 mock). 통합 브랜치는 `nicepay`→NicepayPaymentProvider(fail-closed), toss/portone→`disabled`, 운영 빌드에서 mock 은 `NEXT_PUBLIC_ALLOW_MOCK_PAYMENT=true` 일 때만. 코드 상수 `NICEPAY_CHECKOUT_ACTIVATED=false` 이므로 환경변수만으로는 결제창이 열리지 않는다(이 값은 이번에도 false 로 유지, 커밋에 true 없음).
- Toss 영향: `TossPaymentProvider`·`PortOnePaymentProvider` 클라이언트 어댑터 삭제(신규 Toss 결제 불가). 과거 Toss 거래의 조회·취소·환불 서버 라우트(`app/api/payments/*`, `lib/payments/server/toss.ts`)는 유지. Toss 심사 계정의 `pg_checkout_override` 값은 변경 없음(NICEPAY 결제에는 쓰이지 않음).
- 법적 정보·홈 푸터: `lib/businessInfo.ts`·홈 푸터(사업자등록 주소 표시)는 통합 브랜치에서만 변경 — 충돌 없음. 주소 값은 코드 상수 그대로이며 이번 작업의 로그·QA 증거·문서에 출력하지 않았다.
- 최신 main 의 테스트·빌드: 통합 결과 vitest 2837 통과(10 건너뜀), 린트 새 오류 0, 빌드 성공(로컬 격리 환경변수).

## 2. 통합 중 발견·수정한 결함
| # | 결함 | 수정 |
|---|---|---|
| 1 | NICEPAY 주문의 복귀 토큰 발급(`/api/payments/return-token`)이 **토스 규칙(`pg_checkout_override`)** 으로 게이트를 판정 → NICEPAY 심사관(`nicepay_review_access`)은 403 으로 막히고, 토스 심사 계정은 통과 | `lib/payments/server/deps.ts` `gateAllows`: 주문 provider 가 nicepay 면 NICEPAY 게이트(`nicepayGate`)로 판정 |
| 2 | 결제 결과 화면(`/checkout/nicepay/result`)이 주소창 토큰을 지운 직후 "확인 정보가 올바르지 않거나 만료됐어요" 를 정상 결과 옆에 잘못 표시 | 첫 렌더 쿼리로 한 번만 판정(`useState` 초기값) |
| 3 | 서버가 인증 결과를 거절(서명/금액/MID 불일치·승인 거절 등)해도 결과 화면이 상태가 확정될 때까지 오래 폴링 | `handleReturnPost`: 4xx/5xx(진행 중 `in_progress` 제외)면 `&failed=1` — 즉시 실패 안내(상태 불명·진행 중은 계속 확인) |
| 4 | NICEPAY 일 때도 카카오페이·토스페이·계좌이체가 노출되고 선택 시 v3(카드 전용) 검증에서 오류 | `lib/payMethods.ts methodsForProvider` — NICEPAY 면 카드·직접결제만(체크아웃·장바구니) |
| 5 | returnUrl POST 를 UTF-8 로만 해석(v3 form 은 `accept-charset=euc-kr`) | `lib/payments/server/nicepay/formBody.ts`: charset 헤더→ASCII→엄격 UTF-8→EUC-KR 순 해석, 중복 필드는 첫 값만(서명 필드 덮어쓰기 방지), 64KB 상한 |
| 6 | 앱 쪽 게이트가 심사관 **권한만** 확인(DB 가 최종 방어선) | `nicepayGate`: 주문의 센터·상품이 승인·공개된 심사 센터의 판매 중 상품인지 테이블 조회로 선검사(P2b 보조 함수와 같은 조건, 조회 오류=거부). `nicepay_order_is_review_target` 은 소유자만 실행 가능해 service_role 이 호출하지 못하므로 SQL 변경 없이 TS 로 구현 |
| 7 | 복귀 주소는 https 만 허용 → 로컬 브라우저 QA 불가 | sandbox 환경에서만 `http://localhost[:포트]` 허용(production 은 localhost 도 거부) |

## 3. 결제창(v3) 구현 상태 — 공식 문서 항목별
| 항목 | 상태 |
|---|---|
| goPay() 호출(SDK `nicepay-pgweb.js`, 허용 URL 고정) | 구현·**모의 SDK 로 격리 브라우저 검증**. 실제 SDK 호출은 BLOCKED(MID 발급·승인 필요) |
| 서버 서명 생성(SignData = sha256(EdiDate+MID+Amt+MerchantKey)) | 구현·단위/브라우저 검증. MerchantKey 는 서버 전용, 브라우저 form 에 비밀 필드 없음(테스트로 고정) |
| MID·금액·주문번호 서버 검증 | 구현: 금액·상품은 DB 주문에서만, 인증결과 Signature/MID/Amt 검증, 승인 응답 Signature·TID·Moid·MID·Amt 검증 |
| PC·모바일 결제창 | PC=layer(nicepaySubmit), 모바일=ReturnURL 복귀. 로직은 동일 서버 경로 — 모바일 폭·WebView UA 에뮬레이션 검증. **실기기·실제 NICEPAY 모바일 결제창은 BLOCKED** |
| 인증 응답 ≠ 승인 | 브라우저는 승인을 호출하지 못함. 서버 ReturnURL 이 서명·금액 검증 후에만 승인(NextAppURL 은 허용 호스트만) |
| ReturnURL·모바일 복귀 | 서명된 주문 전용 토큰(rt)으로 로그인 세션 없는 WebView 에서도 결과 확인(검증), 토큰 없음/위조는 invalid |
| EUC-KR | form `accept-charset=euc-kr`, 서버는 EUC-KR 응답 해석(단위 시험). 승인 API 는 CharSet=utf-8 로 고정 |
| 취소·닫기·실패·재시도 | 닫기→주문 취소→같은 화면 재시도 성공, SDK 로드 실패→주문 정리, 승인 거절/응답 불일치/무응답/5xx→망취소·pending 복귀 |
| 위변조·금액 불일치·중복 | 서명 위변조·금액 불일치·허용되지 않은 NextAppURL → 승인 호출 0, 동일 인증 결과 재전송·동시 3중 전송 → 승인 1회·수강권 1개 |
| 인증 성공만으로 완료 금지 | DB 주문 상태 done 일 때만 완료 표시·수강권 발급(승인 기록 없으면 DB 가 발급 거부) |

## 4. 격리 브라우저 QA 결과(Chromium 23건 PASS)
실행: `ISO_ENV_FILE=<env> scripts/isolated/nicepayQa/run.sh` (로컬 일회용 Supabase + 모의 SDK + 서버 fetch 가로채기). 코드 상수를 **실행 중에만** true 로 바꾸고 종료 시 반드시 원복(원복 후 git diff 없음 확인, 커밋 불가). 증거: `docs/qa/nicepay-main-integration-20261031/qa/`(results.json, 스크린샷 28장, 모의 서버 호출 로그, 서버 로그(토큰 가림)).
- 게이트 off: 심사관도 결제창·주문 없음 / reviewer: 일반 회원·토스 심사관은 심사 상품 미노출·운영 센터에서 카드 미노출 / 심사관 결제 성공(수강권 1개, 외부 호출 0) / public(공개 플래그 꺼짐): 일반 회원 카드 미노출, 직접결제 정상 / 심사관은 운영 센터 상품 미노출.
- 홈 푸터에 사업자 정보(주소 포함)가 표시됨(값은 출력하지 않고 포함 여부만 단언), 심사 상품 3종에 사전예약기간·서비스 제공기간(날짜)이 표시되고 제공기간 ≤ 365일.

## 5. 홈페이지 요구사항
A. 사업자등록 주소: 푸터 표시 구현·검증(로컬). **운영 배포가 곧 공개**이므로 배포는 별도 승인 사항. B. 서비스 제공기간·사전예약: 실제 상품 규칙(`lib/servicePeriod.ts`, 서버 SQL 과 PGlite 전수 대조)으로 계산해 표시 — 심사 상품은 결제일=시작일(사전예약 0일), 7·28·90일(≤365). 존재하지 않는 기간은 만들지 않는다(정보가 없으면 공통 안내). C. 심사관 로그인→심사 센터→상품 상세→기간 확인→주문 생성→결제창 호출 흐름 검증(모의 SDK).

## 6. P3 심사 센터(실행하지 않음) — 검토 결과
`seed_nicepay_review_center_20261028.sql` 은 현재 스키마(P2·P2b 적용 후)에서 로컬 검증됨. 확인한 것: 센터 approved·`is_internal=false`·`is_nicepay_review=true` 에서 일반 회원·토스 심사관·비로그인에게 센터·상품·수업이 보이지 않고 NICEPAY 심사관만 접근, 기존 센터·상품·회원 데이터 불변(지문 동일), 종료·롤백 경로(`close_nicepay_review_20261029.sql` → P2b 롤백 → P2 롤백, 회원 관계가 있으면 롤백이 중단) 안전.
**사용자 확정이 필요한 값**: 센터 표시명("[심사 전용] MWHABIT NICEPAY 카드사 심사 환경" — 심사 환경임을 밝힘; "실제 운영과 동일한 형태"를 원하면 문구 조정), 상품 가격(현재 1,000/4,000/10,000원 — 카드 승인 최소금액·현실성은 NICEPAY 확인 필요), 이용기간(7/28/90일, 모두 사전예약 0일·서비스 ≤1년). 센터 주소·사업자번호는 임의로 만들지 않아 null.

## 7. (2026-10-31 추가) 사업장 소재지 공개 범위와 플래그
- 현재 운영의 공개 범위: `/legal/business`(로그인 없이 열람) + 관리자 구독 화면. **홈 푸터·`/products` 푸터는 이 변경으로 새로 노출되는 곳**이다.
- 제어: Vercel 환경변수 `NEXT_PUBLIC_SHOW_BUSINESS_ADDRESS_IN_FOOTER`(정확히 `true` 일 때만 표시, 기본·Preview·Production 모두 꺼짐). 카드사 심사 요구는 이 값을 사용자 승인 후 켜서 충족한다(코드 변경 불필요, 재배포 필요 — 빌드 시점 인라인).
- 꺼진 빌드의 홈·상품 번들·HTML 에는 주소 문자열이 없다(빌드 산출물 검사 + `next start` 로 홈·상품 HTML 0건, API 404 확인).
