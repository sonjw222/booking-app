# NICEPAY 센터 구독 심사 경로 운영 반영 — 2026-11-16

## 배포 결과와 승인

사용자가 심사 계정 전용 카드등록창의 운영 반영을 명시 승인했다. 이에 따라 이번 기능에 필요한 Production 배포 및 전용 서버 환경설정만 추가했다. 실제 카드 인증·빌키 발급·첫 결제·월 청구·DB 변경·push/PR/main 병합 승인이 아니다.

- 저장소: sonjw222/booking-app. 새 독립 로컬 clone/브랜치 `feat/nicepay-subscription-production-review-20261116`.
- 실제 배포 커밋: `33bc408c8b31babddd0d78c84760b0aa2e70f92c`.
- 기준: 당시 운영 수강권 드래그 수정본 `4093ee62`. 별도 작업본의 배포 기록과 현재 alias 대조로 확인했다. API에서 제공한 source 목록은 부분 목록으로 Git SHA를 포함하지 않아, 공개된 소스 내용 hash 일부 일치 및 기존 배포 기록을 함께 근거로 사용했다. 부분 목록을 전체 내용 일치 증명으로 취급하지 않는다.
- Production 배포: **dpl_A9qKXh6tgptX2dsUNjmR8RCoAp5C / READY**.
- 배포 주소: https://booking-dxh81ucwd-sonjw.vercel.app
- 운영 주소: https://mwhabit.com
- Production 환경으로 도메인 미연결 배포 → 인증된 스테이징 검증 → 같은 배포 promote. 승격 직전 alias가 이전 배포 그대로인지 확인했다.
- 롤백 대상: `dpl_Dx7S76kMzpUNJcJVE4Kvn3KyHFrv`. 필요 시 기존 프로젝트의 해당 Production 배포를 다시 promote한다. 이번에는 롤백을 실행하지 않았다.

## 실제 동작

공개 상품 안내 `/center-subscription` → niceqa 오너 로그인 → `/manager/subscription` → **카드 등록 심사용 확인** → `/manager/subscription/nicepay-review` → 실제 NICEPAY 호스팅 창.

사용자가 별도 IAB 화면에서 직접 로그인했다. 서버가 고정 niceqa UID/확인된 이메일, 심사 권한, QA 센터 active 오너, 내부 QA 센터, 월39000 활성 플랜, pending_billing_setup, 기존 billing 참조 null, **billing_review_override=false** 조건을 실제 조회해 진입을 허용했다. 기존 Chrome의 다른 오너 계정에서는 동일 기능이 잠기는 것을 확인했다. 그 계정의 로그인/데이터는 변경하지 않았다. 사업 DB 쓰기나 수동 SQL을 실행하지 않았다.

실제 운영 브라우저에서 등록창을 열어 카드번호·유효기간·비밀번호·식별정보 항목을 확인했다. 카드정보 입력, 약관 동의, 등록/인증은 하지 않았다. X → PG의 종료 확인 → 종료를 눌러 **카드등록과 청구를 진행하지 않았다는 안내**가 표시되는 기존 심사 페이지로 복귀했다. 월39000과 창의 비청구 인증용1000을 구분한다. 이 검증은 실제 BID/청구 가능 여부나 카드사 심사 승인 증거가 아니다.

- PC 창 경로: NICEPAY 공식 SDK → dc1-web의 `webstd/billing/payment.jsp`.
- 브라우저 기본 IAB319px에서는 데스크톱 PG 창이 가로로 잘렸다. 이를 모바일/iPhone 결과로 기록하지 않았다. PC 창 검증에 필요한 1280×900 크기로 확인한 뒤 원래 viewport로 복원했다.
- 실제 운영 iPhone WKWebView 재검사는 아직 **BLOCKED / 사용자 확인 필요**다. 별도 QA 앱1.0(8)의 이전 실기기 PASS와 구분한다. 이번 변경은 웹 기능이며 iOS/Android나 TestFlight 빌드를 변경하지 않았다.

## 구현과 결제 경계

- server MID/SignData, Amt1000, BillAuthYN=Y, 고정 ReturnURL, 상태 HMAC/시간/계정/센터/주문/금액/서명/결과코드/AuthToken/TxTid 검증 구현을 현재 운영 기준에 통합했다.
- 원본 카드정보를 모하빗 폼/서버/DB/로그에 수집하지 않는다. 원본 PG 메시지/임의 필드도 결과 HTML에 반사하지 않는다.
- BID 발급 게이트는 코드 false이며 실발급 transport가 없다. NICEPAY billing 활성도 코드 false, 첫 결제/cron 연결 없음. Toss confirm/charge-due 및 lib/centerSubscription 변경 없음.
- 초기 도입 테스트의 import 허용 목록을 최신 운영 qaAuthOnly 예외를 유지하며 확장했다.
- 고정 ReturnURL HTML을 허용된 NICEPAY PG 및 self iframe에서만 표시하도록 CSP ancestors를 제한했다. 복귀 링크는 `_top`으로 iframe을 빠져나온다. 서명 검증이나 인가를 완화하지 않았다. 정상 인증 후 1회 발급 소비는 미구현/이번 범위 아님.

## 환경설정

이번 운영 반영 승인으로 Production에 아래 9개를 추가했다. 기존 단건결제/기타 환경 값은 덮어쓰지 않았다.

- NICEPAY_SUBSCRIPTION_REVIEW_ENABLED=true
- NICEPAY_SUBSCRIPTION_REVIEW_ORIGIN=https://mwhabit.com
- NICEPAY_SUBSCRIPTION_HOSTED_REVIEW_ENABLED=true
- NICEPAY_SUBSCRIPTION_MID: 서버 Secret (원문 미기재)
- NICEPAY_SUBSCRIPTION_MERCHANT_KEY: 서버 Secret (원문 미기재)
- NICEPAY_SUBSCRIPTION_REVIEW_STATE_SECRET: 새 무작위 서버 Secret (원문 미기재)
- NICEPAY_BID_ISSUANCE_ENABLED=false
- NICEPAY_BILLING_ENABLED=false
- NEXT_PUBLIC_BILLING_ENABLED=false: 기존 미설정의 비활성 기본 동작을 명시적 OFF로 고정.

전용 MID/상점키는 사용자가 이미 저장한 private 파일을 로컬 프로세스 메모리에서 읽어 CLI stdin으로 저장했다. Secret 값을 명령 인자·채팅·로그·코드·자료에 출력하지 않았다. 전용 상태 Secret도 프로세스에서 생성해 저장했다. 기존 NICEPAY_CHECKOUT_ENABLED=false, NEXT_PUBLIC_PG_CHECKOUT_ENABLED=false, 회원 심사 창 enabled=true는 유지한다. 기존 Toss/회원 단건 빌링키와 공유하지 않는다.

전체 되돌림이 필요하면 이전 정상 배포로 롤백 후 이번에 추가한 9개만 정리할 수 있다. 기존 변수 삭제/변경은 하지 않는다. 삭제는 이번에 실행하지 않았다.

## 검증

| 항목 | 결과 |
|---|---|
| Vitest 전체 | PASS — 3,295 passed /10 skipped. 최초 Swift 캐시 접근 제한 2건은 정상 캐시 접근 재실행으로 모두 해소 |
| lint | PASS — 신규0, 기존1,481. 변경 파일 strict 검사에는 기존9오류/4경고가 포함되며 프로젝트 baseline 검사 통과 |
| TypeScript 전체 | FAIL_EXISTING — 기존63/신규0, 현재 운영 baseline 로그와 완전 동일 |
| 로컬 Next webpack build | PASS — 허구의 공개 설정으로 실행, 실제 PG/DB 접근 없이 컴파일 |
| Vercel remote Next/Turbopack build | PASS — 처음 배포는 tests 제외로 기존 스크립트 import 실패. 추적 tests를 포함해 동일 소스 커밋으로 재배포 성공 |
| 모의 iframe 복귀 | PASS — 신뢰된 PG ancestor에서 안내 표시·top 복귀, 신뢰하지 않는 ancestor는 차단. 모든 요청 가로채기, 실제 PG/Auth/DB0 |
| 스테이징 HTTP | PASS 7/7 — 인증된 Vercel 요청, 공개 링크 없이 수행 |
| 운영 HTTP | PASS 7/7 — 홈/상품/심사 페이지/비로그인401/변조 Return400/정보성 결과200/기존 결제503 |
| 운영 niceqa 권한/진입 | PASS — 사용자가 로그인 후 서버 조건 판정, 전용 링크/버튼 확인 |
| 운영 다른 오너 거부 | PASS — 지정 계정이 아닌 기존 오너 계정에서 기능 잠김 확인 |
| 실제 PG PC 창/X 종료/복귀 | PASS — 카드 입력·동의·인증 없이 수행 |
| 운영 iPhone 재검사 | BLOCKED — 별도 QA 앱의 실기기 결과와 구분 |
| 실제 인증 결과/BID/승인/cron/첫 결제 | BLOCKED/미실행. 게이트 계속 OFF |
| iOS build | 웹만 변경해 재빌드 미실행. 전체 단위 테스트의 Swift 순수 검사 PASS. 기존 QA8 archive 검증은 별도 기록 |
| 비밀 스캔 | PASS — 변경 소스와 갱신 PPTX에 private MID/KEY 없음 |

운영 HTTP의 첫 Python 기본 User-Agent 요청은 Cloudflare403을 받았다. 일반 웹 요청 식별자로 재실행해 7/7 통과했고, 실제 브라우저에서도 운영 화면/기능을 검증했다. 이를 애플리케이션 인증/배포 실패와 구분한다.

보호된 스테이징에 누구나23시간 접근하는 공유 링크 생성은 자동 승인 검사에서 공개 대상/기간의 별도 승인이 없다는 이유로 거부됐다. 링크는 생성하지 않았고 거부를 우회하지 않았다. 대신 기존 Vercel 인증의 `vercel curl`로 읽기 전용 검증을 완료했다. 보호 설정이나 Trusted Sources를 낮추지 않았다.

## SQL 보고

1. 변경 파일 목록: 아래와 results.json 참조. 제품13개, 관련 테스트8개 및 검증 문서/이미지. 기존 UX 변경 전체를 재적용하지 않고 현재 운영 기준에 심사 기능만 분리했다.
2. SQL 실행 필요 여부: **NO**.
3. SQL 파일 경로: 해당 없음.
4. SQL 실행 순서: 해당 없음.
5. Supabase 직접 실행할 SQL 전문: 해당 없음.
6. 실행 후 확인 방법: SQL 실행 없음. 지정 심사 계정으로 구독 → 심사용 확인 → 창 열기 → 카드 입력 없이 X 종료/복귀, 비인가 계정 차단, 결제/발급/cron OFF 확인. 실제 인증/BID/청구는 확인 범위가 아님.

## 격리·자료·남은 확인

원본 Claude UX 워크트리/브랜치, PR264/265, main은 수정하지 않았다. GitHub push·PR생성·main병합 없음. 운영 SQL/업무 DB 쓰기 없음. QA센터/오너/billing_review_override 변경 없음. 추가 NICEPAY 메일 없음. 이번에는 사용자가 승인한 전용 환경설정과 Production 배포만 실행했다.

최신 심사 PPT는 프로젝트 출력 폴더의 `MWHABIT_NICEPAY_Production_Review_20261116.pptx`다. 이전 QA 전용 미반영 자료를 발송하지 않고, 운영 경로/실제 캡처/QA 실기기 결과와 운영 iPhone 미검증 상태를 구분해 갱신했다. 아직 메일 첨부로 보내지 않았다. 원문 MID/KEY/비밀번호/일회성 링크 없음.

신규 MID로 BillAuthYN=Y 호스팅 창 호출 가능은 운영에서 확인했다. 실제 BID 발급 서비스 활성, 카드사 심사 승인, 실제 청구 가능 여부는 미확인이다. BID 발급/저장/실청구 단계는 별도 설계와 승인 전까지 진행하지 않는다.

## 변경 파일

- `app/api/billing/nicepay/registration-review/result/route.ts`
- `app/api/billing/nicepay/registration-review/return/route.ts`
- `app/api/billing/nicepay/registration-review/route.ts`
- `app/components/ManagerChrome.tsx`
- `app/components/NicepaySubscriptionReview.tsx`
- `app/manager/subscription/nicepay-review/page.tsx`
- `app/manager/subscription/page.tsx`
- `lib/payments/nicepaySubscriptionReviewProtocol.ts`
- `lib/payments/nicepaySubscriptionReviewWindow.ts`
- `lib/payments/server/nicepay/billing.ts`
- `lib/payments/server/nicepay/subscriptionReview.ts`
- `lib/payments/server/nicepay/subscriptionReviewHttp.ts`
- `lib/payments/server/nicepay/subscriptionReviewRuntime.ts`
- `tests/qa/subscriptionReviewProduction/returnBrowser.mjs`
- `tests/unit/nicepay.offline.test.ts`
- `tests/unit/nicepay.subscriptionReview.client.test.ts`
- `tests/unit/nicepay.subscriptionReview.routes.test.ts`
- `tests/unit/nicepay.subscriptionReview.runtime.test.ts`
- `tests/unit/nicepay.subscriptionReview.test.ts`
- `tests/unit/nicepay.subscriptionReview.window.test.ts`
- `tests/unit/nicepayReviewWording.test.ts`
