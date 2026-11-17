# 기존 App Store 모하빗: NICEPAY 결제창 확인 모드

상태: 격리 브랜치에서 구현·모의 검증 완료. 운영 반영 전 사용자 검토 단계. 기존 앱에 아직 반영되지 않았다.

브랜치: `qa/nicepay-existing-app-auth-only-20261105`.
기준: 실제 mwhabit.com 배포의 main SHA `368aa3e104116934209d2cd93d72c10a3d27f2e7`.
기존 운영 배포: `dpl_BtfRSgFfYdGx1FMYHAJCjcRZzJiP` (반영 직전 재확인 필요).

## 1. 공식 회신과 기존 코드의 차이

기존 배포는 인증 결과가 검증되면 승인 API를 호출하는 2TR 경로다. 운영 설정은 NICEPAY_CHECKOUT_ENABLED=false, NEXT_PUBLIC_PG_CHECKOUT_ENABLED=false이며, Preview에 있는 AUTH_ONLY 설정은 Production에 없었다. 버튼에 카드 옵션이 보여도 결제창 검증이 준비된 것은 아니었다.

별도 QA 앱/임시 터널 방식은 사용자 요청으로 중단했다. 이번 구현은 현재 App Store 앱의 HTTPS 운영 웹 화면에 지정 심사 계정·센터만 사용하는 읽기 전용 테스트 진입점을 추가한다. 운영 결제 활성화를 위해 기존 플래그를 켜지 않는다.

공식 WapUrl={scheme}://, IspCancelUrl={scheme}://{복귀경로}는 네이티브 scheme 등록과 쌍으로 배포해야 한다. 현재 확인한 운영 소스의 네이티브 설정에는 NICEPAY 전용 scheme 등록이 없다. 이번에는 미등록 scheme을 임의로 넣지 않으며 **카드사 앱 전환/네이티브 딥링크 복귀 검증 완료로 간주하지 않는다.** 고정 HTTPS ReturnURL만 사용해 결제창 표시·닫기를 확인하도록 한다. 모바일 전환은 기존 goPay SDK를 사용하고 새 iframe을 구현하지 않았다.

## 2. 변경 파일

핵심 추가 파일:

- `lib/payments/server/nicepay/reviewWindow.ts`: 전용 설정, UID·센터 고정, 테스트 거래 발급 및 HMAC 복귀 검증.
- `lib/payments/server/nicepay/reviewWindowRuntime.ts`: Auth 조회 및 accounts/centers/products SELECT만 제공하는 의존성. 실제 결제 런타임을 import하지 않는다.
- `app/api/payments/nicepay/review-window/route.ts`: 본인 Bearer 검증 후 check/open만 허용.
- `app/api/payments/nicepay/review-window/return/route.ts`: POST 전용, EUC-KR/UTF-8 파서 재사용. 승인 경로로 fallback하지 않는다.
- `app/api/payments/nicepay/review-window/result/route.ts`: 서명된 테스트 결과만 읽어 고정 문구 표시. no-store/no-referrer/CSP 적용, 응답값·토큰·개인정보를 HTML에 반사하지 않는다.
- `lib/payments/reviewWindowClient.ts`: 공용 MID 및 전용 ReturnURL 확인, 알 수 없는 form 필드 제거.
- `app/components/NicepayReviewWindow.tsx`, `app/checkout/page.tsx`: 지정 사용자에게만 서버 확인 후 '카드 결제창 확인 (승인 없음)' 표시. 일반 사용자에게는 버튼/SDK 호출/추가 조회 요청 없음.
- `tests/unit/nicepay.reviewWindow*.test.ts`: 설정·권한·서명·위변조·만료·재전송·HTTP·화면·로그인 변경 경합 검사.

빌드 호환성 수정: 기존 login/my-reservations/settings/theme 페이지에서 Next.js가 금지하는 named export를 순수 lib 모듈(signupMessages/reservationDisplay/themeSettings)로 이동하고 기존 테스트 import만 바꿨다. 문구·계산·테마 적용·로그인 동작은 유지했다. 전체 파일 목록은 CHANGED-FILES.txt에 기록한다.

## 3. 복귀 URL

- 요청: `POST https://mwhabit.com/api/payments/nicepay/review-window`.
- NICEPAY ReturnURL: `https://mwhabit.com/api/payments/nicepay/review-window/return?rt={전용HMAC문맥}`.
- 안내 화면: `https://mwhabit.com/api/payments/nicepay/review-window/result?rt={서명된결과}`.
- 변조/누락/만료 시 서명된 성공 상태 대신 일반 '테스트 복귀 정보 확인 불가' 화면으로 이동한다. 외부 URL로 리다이렉트하지 않는다.

기존 실제 주문용 prepare/return/status/abandon 및 결제 완료 화면은 수정하지 않았다.

## 4. 사용자·테스트 거래 식별과 검증

- 허용 UID: niceqa@mwhabit.com으로 확인된 `7ffcf57d-b6d1-4562-a260-33be15f66ee5`.
- 허용 센터: '모하빗 스튜디오 (NICEPAY 카드사 심사용)' ID `1c02c063-8da4-43b5-b88a-514434371c46`.
- 서버에서 이메일 확인 완료 및 정확한 UID/이메일, accounts.nicepay_review_access=true/is_member=true/비탈퇴·비병합, 승인된 비내부 심사 센터, 그 센터의 활성·판매 중 상품을 확인한다. 복귀 시에도 현재 권한/상품 가격을 재확인한다.
- 고객이 보낸 가격·센터·상품명은 사용하지 않고 productId로 서버에서 읽은 기본 가격만 사용한다. 할인·포인트는 테스트에 적용하지 않는다.
- 매번 새 Moid(UUID)를 발급하고 UID·센터·상품·금액·발급시각·10분 만료·목적을 전용 HMAC 토큰에 묶는다. **실제 orders 주문번호가 아니라 DB에 저장하지 않는 테스트 거래 식별자다.** 기존 주문용 return token과 호환되지 않는다.
- 인증 성공 POST도 Moid/MID/Amt/AuthToken/TxTid/Signature를 검증한 뒤 '인증 결과 확인 · 승인 안 함'으로만 표시한다. 승인·수강권 발급·결제 완료 상태를 생성하지 않는다. 임의 호출·재전송도 읽기만 반복한다.
- 브라우저 로그인 변경/상품 변경/중복 클릭/창이 열린 중 재호출을 방어한다. 세션 검증은 서버의 getUser가 최종 수행한다.
- 기존 ReturnURL POST·서명 검증·인증/승인 구분은 그대로 유지한다. 새 경로에는 승인·망취소·환불 API나 DB 쓰기 의존성이 없다.

## 5. SQL

신규 SQL 필요 없음. 신규 SQL 파일 없음. 실행 순서 없음. SQL 전문: 해당 없음.
이번 작업에서 Production SQL 및 운영 데이터 쓰기 실행 0회. 기존 계정/센터/상품을 읽기만 한다. 실제 운영 검증 중에도 이 전용 버튼은 주문·이용권·포인트·예약을 만들거나 변경하지 않는다.
검증: fake 읽기 전용 포트에서 동작하며 외부 fetch를 금지한 테스트에서 정상 인증·재전송까지 통과했다. 실제 운영 API/DB로 테스트 요청을 보내지 않았다.

## 6. 빌드·테스트 및 한계

- 기존 NICEPAY/화면 회귀 검사: 27파일 통과, 1파일 건너뜀, 313개 통과·10개 건너뜀. 새 테스트 1개 추가 후 전용 4파일 31개 재검사 통과. 근거: regression.log / review-window-tests.log.
- app/lib TypeScript 검사 통과. 전체 Next.js Webpack 빌드 통과. 실제 환경값 대신 build-only.invalid 및 더미 키 사용.
- 모의 UI 검사: 일반 계정 숨김 및 요청 없음, 명시적 클릭 전 SDK 미호출, 중복 클릭 1회, 닫기 시 주문 요청 없음, 요청 도중 계정 변경 시 goPay 미호출.
- OAuth/FCM/네이티브 설정 변경 없음. React 검토: 서버 비밀 클라이언트 import 없음, effect cleanup·세션 변경 방어·aria-live·type=button 적용.
- iOS/Android 네이티브 신규 빌드 없음(기존 App Store 앱의 웹 화면 변경). 사용자가 기존 iPhone 앱의 로그인·센터·상품·상세·결제수단 표시를 확인했다. 실제 외부 NICEPAY 창·취소 복귀, Android 실기기, 카드사 앱·콜드 스타트는 아직 미검증이다.
- 실제 카드번호 입력·카드 인증 금지는 계속 유지된다. NICEPAY 공용 테스트 카드는 없으며, 이번 모의 검증을 실제 외부 인증 성공으로 보고하지 않는다.

## 7. 실제 승인 API 호출

0회. 실제 NICEPAY 인증/카드 입력도 0회. 테스트의 AuthToken/Signature/goPay는 모의 값·스텁이다.

## 8. 미변경 확인 및 운영 반영안

운영 앱 배포·DB·환경변수·main·기존 PR·실행 중 Cloudflare 터널은 변경하지 않았다. 모든 구현은 새 격리 브랜치에 있다. 원본 작업 폴더의 기존 사용자 변경은 보존했다.

운영 반영을 승인받는 경우에만 다음을 수행한다:

1. 현재 Production 배포 SHA 및 전역 결제 OFF 설정 재확인. 다른 작업의 변경이 있으면 충돌을 먼저 검토한다.
2. 새 서버 전용 환경변수 3개만 구성: NICEPAY_REVIEW_TEST_MERCHANT_KEY(공식 nicepay00m 공용 테스트 키), NICEPAY_REVIEW_WINDOW_SECRET(별도 랜덤 비밀), NICEPAY_REVIEW_WINDOW_ENABLED=true. 비밀은 Vercel Secret으로 저장하며 채팅/소스/로그에 기록하지 않는다.
3. NICEPAY_CHECKOUT_ENABLED=false, NEXT_PUBLIC_PG_CHECKOUT_ENABLED=false 및 기존 운영 MID·MerchantKey는 그대로 둔다. 기존 운영 키를 읽거나 테스트에 사용하지 않는다.
4. main 병합·기존 PR 수정 없이 검토된 격리 브랜치 코드로 배포한다. 지정 계정·센터 외에는 새 UI가 없다. Production SQL은 실행하지 않는다.
5. 배포 후 일반 계정 차단 및 niceqa 전용 버튼을 확인한 뒤 사용자가 카드번호 입력 없이 결제창 표시·닫기만 확인한다. 실제 카드 인증 승인은 포함하지 않는다.

되돌리기: 이전 Production 배포로 rollback(반영 직전 기록한 정확한 배포 ID 사용). 새 모드를 꺼야 할 때는 NICEPAY_REVIEW_WINDOW_ENABLED=false로 **재배포**한다(변수 변경만으로 기존 배포가 즉시 바뀐다고 가정하지 않는다). DB 복구·터널 재시작·앱 재설치가 필요 없는 구성이다.

## 9. 사용자 다음 작업 한 단계

검증된 변경을 기존 앱의 운영 웹에 반영할지 승인. 승인 전에는 기존 앱에 테스트 버튼이 보이지 않는다.
