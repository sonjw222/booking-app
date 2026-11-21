# NICEPAY v3 iOS/Android WebView 정적 사전점검 — 2026-10-30

> 대상: GitHub `main` commit `368aa3e`, 테스트 전용 Draft PR #259와 별도. **정적 코드 점검만 수행**하였고 카드사 앱/실기기/실제 NICEPAY 외부 인증창은 테스트하지 않았다. 결제 코드·iOS·Android 설정·운영 DB·Vercel·가맹점 KEY는 변경하지 않음.
>
> 이 문서는 Native 연동 구현을 승인하거나 활성화하는 문서가 아니다. 기존 Issue #255의 인수 조건을 구체화하며, 실제 WebView 구현/배포는 별도 브랜치·코드 리뷰·실기기 QA가 필요하다.

## 1. 공식 v3 규격: 브라우저와 앱을 구별

근거: NICEPAY 개발자센터 **[결제창 호출하기](https://developers.nicepay.co.kr/docs/pg/auth/payment-window/)** (2026-10-30 검색 확인).

- PC 웹: `goPay(form)` → 레이어 결제창 → `nicepaySubmit()` → 인증 응답 form submit → 가맹점 서버.
- 모바일 웹: `goPay(form)` → NICEPAY 인증 페이지 전환 → `ReturnURL`로 **서버 인증 결과 POST**. 인증 성공 `AuthResultCode=0000`만으로 결제 완료가 아니며 별도 승인 API가 필요.
- **APP WebView**: 카드사/ISP 외부 앱을 거치므로 `WapUrl`과 `IspCancelUrl`을 추가해야 한다고 문서 명시. 이 값은 **가맹점 앱 복귀 스킴**으로서 서버 `ReturnURL`과 역할이 다르다. 임의의 미확인 복귀 스킴을 곧바로 설정하지 말 것.
- v3(MID + MerchantKey)와 다른 NICEPAY REST/v1 `appScheme` 예시는 서로 다른 연동 문서이므로 필드를 혼용하지 않는다.

## 2. 현재 main 코드 정적 확인

| 항목 | 파일 | 확인 결과 | 후속 |
| --- | --- | --- | --- |
| 브라우저 v3 폼 | `lib/payments/nicepayV3Window.ts` | `NicepayV3Params` 및 `FIELD_ORDER`에 `WapUrl`, `IspCancelUrl` 없음 | 모바일 브라우저와 앱 WebView를 **명시적으로 분기**하는 계획. 앱에서만 검증된 값 추가 |
| 결제 요청 | `lib/payments/NicepayPaymentProvider.ts` | 서버 prepare/값 검사 후 공식 SDK `goPay` 호출, 주문번호·금액 확인 | 앱 URL 분기 및 결과 복귀 모의 QA. 서버 KEY는 계속 비노출 |
| iOS 콜백 스킴 | `ios/App/App/Info.plist` | `CFBundleURLTypes`는 확인된 범위에서 Google 로그인용 스킴. NICEPAY 복귀용 고유 스킴과 카드앱 질의 목록 미구성 | 기존 Google 로그인과 충돌 없는 스킴을 확정한 뒤 **별도 native 앱 빌드**에만 적용 |
| iOS URL 처리 | `ios/App/App/SceneDelegate.swift` | GoogleSignIn 처리 + `SceneDelegateProxy` 위임. NICEPAY 전용 URL 복귀·상태 폴링 핸들러 없음 | 기존 OAuth 콜백과 proxy 동작 유지하면서 중복·위조·취소 URL 처리 |
| Android 외부 복귀 | `android/app/src/main/AndroidManifest.xml`, `android/.../MainActivity.java` | 런처 intent-filter는 있으나 NICEPAY 앱 복귀용 BROWSABLE 필터·카드앱/intent 처리 코드가 확인되지 않음 | 명시적인 scheme/host 제한, 인증 결과를 **서버 상태 조회**로만 판정 |
| Capacitor 서버/탐색 | `capacitor.config.ts` | `server.url=https://mwhabit.com`, `allowNavigation`은 OAuth 계열 도메인 목록. NICEPAY 도메인은 해당 목록에 없음 | 앱 내 SDK 이동 동작 실측 필요. 임의로 전체 도메인 허용하거나 ATS/cleartext 전체 개방 금지 |
| 결과 판정 | `app/checkout/nicepay/result/page.tsx` | 서버의 주문 상태가 `done`일 때만 결제 완료 표시, 쿼리의 return token 제거 | 기존 판정 유지. 앱 복귀 자체를 결제 완료로 처리하면 안 됨 |

**중요 설정 정정:** 2026-10-30 기준 `main`의 `NICEPAY_CHECKOUT_ACTIVATED=true`는 이미 PR #258 병합으로 적용되었다. 하지만 **운영 서버 `NICEPAY_CHECKOUT_ENABLED=false`**, **일반회원 `NEXT_PUBLIC_PG_CHECKOUT_ENABLED=false`**, DB `nicepay_checkout_gate.mode=reviewer`이므로 실제 결제 활성화는 아니다. 기존 Issue #255의 `code flag false`, `DB gate off` 기록은 최신 상태와 불일치하며 현 상태로 정정해야 한다.

## 3. 안전한 준비 순서

1. NICEPAY 기술지원 회신으로 v3용 `WapUrl`/`IspCancelUrl`의 정확한 스킴 규격·앱카드 복귀·iOS/Android 적용 조건을 확인. v1 샘플의 `appScheme` 필드를 그대로 대입하지 않는다.
2. 기존 OAuth/Capacitor 딥링크를 조사해 충돌하지 않는 앱 복귀 스킴을 정한다. 임의 URL로 결제 주문을 지정하거나, 복귀 URL에서 사용자/주문 정보를 신뢰하지 않는다.
3. URL 필드 검증을 서버/클라이언트 allowlist로 추가. 비앱 브라우저에서는 불필요한 네이티브 필드를 추가하지 않는다.
4. iOS/Android 네이티브 경로를 각각 별도 브랜치에서 준비하고 (특히 Google/Kakao/Apple 로그인, Push, 앱 뒤로가기) 회귀 검증한다.
5. 모의 SDK와 mock 앱 전환·복귀로 테스트한다. 외부 카드 승인/청구 0건, ReturnURL 토큰 로그 0건, 중복 복귀·조작 URL·카드앱 미설치·사용자 취소를 처리한다.
6. 실제 MerchantKey가 별도 보안 채널에서 확보된 뒤에도 **먼저 격리 브라우저 QA(#259)**. 그 결과가 네이티브 WebView 정상 동작을 보장하지 않으므로, iOS/Android 실제 기기 테스트는 별도 승인 하에 시행한다.
7. 본 Issue를 마칠 때 반드시 Native 릴리스 아카이브/Gradle build 및 기기별 결과를 검증하고, 변경된 native 바이너리의 스토어 재제출 필요 여부를 구분한다. 웹사이트 JS 배포만으로 Info.plist/Manifest 변경을 기기에 적용할 수 없다.

## 4. QA 판정표

| 확인 항목 | 이번 점검 | 실제 통과 조건 |
| --- | --- | --- |
| 결제창 서버/브라우저 모의 QA | PR #259에서 테스트 보고 PASS | 기존 CI 확인 유지 |
| PC 브라우저 NICEPAY 외부 창 | BLOCKED | 테스트 MID 전용 MerchantKey 확보 후 격리 환경 |
| iOS 앱에서 카드사 앱 열기/복귀 | BLOCKED | iOS 별도 앱 빌드 및 실기기 |
| Android 앱에서 카드사 앱 열기/복귀 | BLOCKED | Android 별도 앱 빌드 및 실기기 |
| iOS/Android 로그인·푸시 회귀 | 미수행 | 관련 변경 PR 단위/기기 검증 |
| 서버 승인 API 외부 호출 | 이번 점검 0건 | 격리 QA에서 계속 0건 |
| 일반회원 운영 카드결제 | OFF | 별도 명시적 승인 전 계속 OFF |

## 5. 사용자 승인 경계 / 작업 보고

- 본 PR #260: **문서만 추가**. 앱·API·DB 변경 없음, 판매 상품 변경 없음, 외부 센터(A10TION) 조작 없음.
- 신규 Production SQL 필요: **NO**. 경로: 없음. 실행 순서: 해당 없음. 직접 실행할 변경 SQL: 없음. 실행 후 확인: GitHub diff 및 운영 환경변수 변경 없음.
- Native 구현은 기존 Issue #255 지침에 따라 **별도 worktree·별도 승인**. 코드를 작성하더라도 실기기 PASS 전에는 자동 병합/스토어 반영 금지.
- NotebookLM: 본 파일 + PR #260의 라이브 심사 점검 문서 업로드용. Graphify: 아직 스키마/실제 흐름 미변경이므로 지금 갱신할 필요 없음.
