# NICEPAY v3 모바일 앱(WebView) 결제 복귀 — Issue #255 (2026-10-30, 로컬 커밋 전용)

브랜치 `feat/nicepay-native-webview-return-20261030` = `origin/main`(d27b4fd). **결제 OFF 유지**: `NICEPAY_CHECKOUT_ACTIVATED=false`, DB 게이트 `off`, 앱 복귀 서버 설정(`NICEPAY_APP_RETURN_ENABLED`) 기본 꺼짐. 운영/DEV SQL·운영 환경변수·실제 NICEPAY 호출·push/PR·병합 없음. PR #254(Draft)는 수정하지 않았다.

## 1. 공식 규격(2026-10-30 열람, 호출 없음)
출처: `/docs/pg/auth/payment-window/`, `/docs/pg/add/app-webview`, `/docs/pg/auth/authorization/`, `/docs/pg/auth/net-cancel/`.
| 항목 | 공식 문서 | 이 구현 |
|---|---|---|
| WapUrl | 제휴사(카드사) 앱 인증 후 가맹점 앱으로 복귀하는 **가맹점 App Scheme**(500 byte), WebView 결제 시 추가. 예시 `nicepaysample://` | 서버 설정이 켜진 앱 요청에만 `<scheme>://nicepay/wap?orderId=<uuid>` |
| IspCancelUrl | ISP 인증 취소 시 앱 복귀 스킴 URL(500 byte) | `<scheme>://nicepay/cancel?orderId=<uuid>` |
| ReturnURL | 모바일 필수·절대경로·500 byte. 인증 응답이 이 URL 로 돌아옴 | 변경 없음(HTTPS 서버 경로 + 주문 전용 토큰) |
| 인증 성공 ≠ 승인 | 인증 후 승인 API 필요 | 변경 없음 — 서버 승인 + DB `done` 일 때만 완료 |
| 3rd 앱 호출 등록 | Android 11+ `queries`, iOS `LSApplicationQueriesSchemes`(미등록 시 `canOpenURL` 실패) | 신용카드·공동인증·백신 구분만 등록(아래 §4) |
| iOS WKWebView | `decidePolicyFor`: 비 http(s) → 3rd 앱 처리, ISP/BANKPAY 미설치 → App Store, 그 외는 직접 구현 | Capacitor `shouldOverrideLoad` 훅으로 허용 목록 앱만 열고 미설치 안내 |
| Android WebView | `shouldOverrideUrlLoading`: `intent:`·`market://`·`.apk`·앱 scheme 감지 → `Intent.parseUri`, 앱 없으면 `market://search?q=pname:` | 같은 훅 + 허용 패키지·component/selector/flags/extras 제거 검증 |
| 복귀 | 가맹점 scheme(WapUrl) 등록으로 복귀. **Android 복귀 intent-filter·상세 흐름은 문서에 없음** | iOS `CFBundleURLTypes`, Android `VIEW/BROWSABLE` deep link + 검증 |

### 1.1 공식 샘플과 다르게 한 것(근거 기록)
| 공식 샘플 | 이 구현 | 이유 |
|---|---|---|
| iOS `NSAllowsArbitraryLoads=true` | **추가하지 않음**(ATS 예외 없음) | 문서 스스로 "전체 허용보다 특정 도메인 예외 권장". 요구사항(전체 보안 예외 금지) |
| Android `MIXED_CONTENT_ALWAYS_ALLOW`, `usesCleartextTraffic` | 추가하지 않음 | 앱은 `cleartext:false`(HTTPS) 유지 |
| Android: 감지된 URL 을 `startActivity` | 허용 패키지만, component/selector 거부, flags·extras·추가 category 제거, VIEW+BROWSABLE 만 | 악의적 Intent 실행 방지 |
| 앱 목록 전체(간편결제·계좌이체·본인인증 포함) | **신용카드·공동인증·백신만** | `kakaotalk`·`naversearchthirdlogin` 은 소셜 로그인과 겹침, 나머지는 PayMethod=CARD 에서 미사용 |
| WapUrl = scheme 만(`nicepaysample://`) | `scheme://nicepay/wap?orderId=` | 오래된 앱 재시작·상태 재조회용 주문 UUID 전달. **형식 확정은 NICEPAY 확인 필요(BLOCKED)** — 형식은 `buildAppReturnUrls()` 한 곳 |

## 2. 먼저 확인한 기존 구조·충돌 가능성
- 앱은 Capacitor `server.url=https://mwhabit.com` 셸이다. **Capacitor 기본 동작**(`@capacitor/ios` WebViewDelegationHandler, `@capacitor/android` Bridge.launchIntent): `allowNavigation` 에 없는 최상위 이동은 모두 **바깥(Safari/ACTION_VIEW)으로 넘긴다** — NICEPAY 결제창이 앱 밖 브라우저로 열리고, `intent://` 는 Android 에서 열리지 않으며, 미설치 시 안내가 없고, 결제 화면에서 임의 scheme 이 검증 없이 열린다.
- OAuth: Google 은 SceneDelegate `GIDSignIn.handle` + `CFBundleURLTypes`(2개 scheme), Kakao/Naver/Apple 은 풀페이지 리다이렉트(`allowNavigation`). 이 변경은 **Google 처리 뒤에서만** 우리 scheme 을 가져가고 나머지는 기존 `SceneDelegateProxy`(Capacitor)로 넘긴다(테스트가 순서 고정). 로그인 화면에서는 허용 목록 밖 scheme 을 차단하지 않는다(결제 문맥에서만).
- 앱에는 `appUrlOpen` JS 리스너가 없어 새 scheme 과 충돌하는 웹 처리가 없다.
- PR #254(Draft)와의 겹침: `lib/payments/server/nicepay/flow.ts`(#254=GoodsName 한 줄, 이 작업=prepare 입력/반환), `scripts/isolated/nicepayQa/run.sh`. **병합 시험(`git merge-tree`, 어느 브랜치도 수정하지 않음)**: `flow.ts` 는 자동 병합, 충돌은 `docs/CHANGELOG.md`·`docs/TODO.md`(양쪽 항목을 모두 유지하면 해결)와 `scripts/isolated/nicepayQa/run.sh`(#254 의 `NPQA_ADDRESS_FLAG` 줄과 이 작업의 `NPQA_APP_RETURN` 블록이 인접 — 둘 다 유지) 3개뿐이다.
- ⚠ 사용자의 로컬 `~/Documents/booking-app` 에는 `ios/App/App.xcodeproj/project.pbxproj`·`ios/App/App/Info.plist`·`android/app/build.gradle` 미커밋 변경이 있다. 이 브랜치가 `project.pbxproj`·`Info.plist`·`AndroidManifest.xml`·`MainActivity.java`·`SceneDelegate.swift` 를 바꾸므로, 그 작업 폴더로 가져올 때는 미커밋 변경을 먼저 커밋·정리한 뒤 병합해야 충돌을 피할 수 있다(이 작업은 그 폴더를 건드리지 않았다).

## 3. 구현
### 3.1 서버·웹
- `lib/payments/nicepayAppReturn.ts`(+`nicepayAppAllowlist.json`): scheme 검증(예약/충돌 scheme 거부), `buildAppReturnUrls`, `parseAppReturnUrl`(네이티브와 같은 규칙), 결과 화면 경로, 이동 정책, 카드사 허용 목록. **제안 scheme `mwhabitnicepay`(미확정).**
- `config.ts`: `NICEPAY_APP_RETURN_ENABLED==="true"` **and** 유효한 `NICEPAY_APP_RETURN_SCHEME` 일 때만 `appReturn` 생성. 기본·불완전·잘못된 값은 꺼짐(결제 자체는 영향 없음).
- `flow.ts handlePrepare`: 클라이언트는 `client: "ios"|"android"`(어느 앱인지 **힌트**)만 보낸다. 서버가 설정이 켜져 있고 힌트가 유효할 때만 `WapUrl`/`IspCancelUrl` 을 싣는다 — **URL 은 서버 설정 scheme + DB 주문 UUID 로만 생성, 클라이언트 값은 무시**(테스트). 복귀 URL 에 토큰·키·세션 없음.
- `nicepayV3Window.ts`: 두 필드를 form allowlist 에 추가. 앱에서만, 둘이 함께, 같은 scheme·이 주문 UUID·종류(wap/cancel)가 정확히 일치할 때만 통과(그 밖은 결제창을 열지 않음). 웹 브라우저에서는 있어도 싣지 않는다. `NicepayPaymentProvider`/`nicepayAppClient.ts` 가 Capacitor 로 앱 여부 판정.
- `app/checkout/nicepay/result`: 앱 복귀(`app=1`, rt 없음)는 **로그인 세션(Bearer)** 으로 서버에 상태를 묻는다. `cancel=1` 이면 먼저 주문 정리를 요청(서버가 본인 pending 만 취소). 어느 경우도 **서버가 done 일 때만 "완료"**.
- `capacitor.config.ts`: `allowNavigation` 에 `*.nicepay.co.kr` 추가(결제창을 앱 안에서 열기 위함, 와일드카드 `*` 아님). 카드사 인증 페이지 도메인은 미확정이라 넣지 않음(BLOCKED).
### 3.2 iOS
- `Info.plist`: 기존 Google URL scheme 2개 **유지** + `NicepayAppReturn` scheme 추가, `LSApplicationQueriesSchemes` 29개(공식 표의 신용카드·공동인증 iOS scheme). ATS 예외 없음.
- `NicepayAppReturn.swift`(순수 로직) / `NicepayAppBridgePlugin.swift`(Capacitor 플러그인, `shouldOverrideLoad`): 카드사 scheme → `UIApplication.open`, 열 수 없으면 안내(ISP 는 App Store `id369125087`), 결제 문맥에서 허용 밖 custom scheme 차단, 그 밖은 `nil`(Capacitor 기존 동작 → 로그인 회귀 없음).
- `SceneDelegate.swift`: Google → NICEPAY 복귀 → Capacitor 순서로 `openURLContexts` 처리, 콜드 스타트 `connectionOptions.urlContexts` 처리(1초 지연, Capacitor 첫 로드 이후).
### 3.3 Android
- `AndroidManifest.xml`: `<queries>` 24개 패키지(카드·공동인증·백신), MainActivity 에 `VIEW/DEFAULT/BROWSABLE` deep link(`mwhabitnicepay://nicepay`) 1개. 기존 `launchMode=singleTask`·`exported`·`allowBackup=false` 유지.
- `NicepayAppReturn.java`(순수 로직, JVM 단위 테스트 9) / `NicepayAppBridgePlugin.java`: `intent://`(허용 패키지·component/selector 없음·VIEW 뿐·위험 data scheme 거부·flags/extras/category 제거), `market://`(허용 패키지만), 카드사 scheme, 결제 문맥 임의 scheme 차단, 미설치 안내(ISP 는 Play 스토어), 복귀 deep link 검증.
- `MainActivity.java`: 플러그인 등록, `onCreate`(콜드 스타트)·`onNewIntent` 에서 복귀 처리, 그 밖은 Capacitor 기존 처리.
### 3.4 복귀 처리 규칙(웹=iOS=Android 동일)
| 상황 | 처리 |
|---|---|
| `…/wap?orderId=<uuid>`, WebView 가 NICEPAY/결제 화면 | **화면을 바꾸지 않는다**(인증 → ReturnURL → 서버 승인 흐름을 끊지 않음) |
| `…/wap`, 앱 재시작(콜드 스타트)·다른 화면 | 결제 결과 화면(`/checkout/nicepay/result?orderId&app=1`)으로 → 서버 상태 조회 |
| `…/cancel`(ISP 취소) | 결과 화면 `&cancel=1` → 본인 pending 주문 정리 → 서버 상태 |
| 3초 내 같은 URL 중복 | 무시(결과 화면도 멱등) |
| 형식 위반·다른 host/path/추가 쿼리/fragment/userinfo/포트/대문자 UUID/500byte 초과 | 아무것도 하지 않음(WebView 에 로드하지 않음) |
| 복귀했다는 사실 | **결제 성공이 아님** — 서버 DB `done` 만이 결과 |

## 4. 허용 목록(공식 "3rd 앱 호출 등록" 표 기준)
신용카드(삼성·신한·현대·KB·ISP/페이북·하나·롯데·NH·우리·씨티·카카오뱅크)·공동인증(하나, 라이콥)·백신(TouchEn mVaccine·V3·V-Guard) — iOS scheme 29개 / Android 패키지 24개(`lib/payments/nicepayAppAllowlist.json` 단일 출처, Swift·Java·plist·Manifest 와 소스 동일성 테스트). 제외: 간편결제·계좌이체·본인인증 앱과 `kakaotalk`·`naversearchthirdlogin`·`supertoss` 등 로그인 겹침 scheme. 앱사 정책에 따라 바뀔 수 있어 운영 전 최신 샘플 재확인 필요(공식 문서 안내).

## 5. 환경별 form 필드·경로
| 환경 | form 필드 | 결제창 | 복귀 |
|---|---|---|---|
| PC 웹 | 기존 9개(MID·Moid·Amt·GoodsName·EdiDate·SignData·ReturnURL·PayMethod·CharSet) | 레이어 팝업 → `nicepaySubmit` → 서버 ReturnURL | 기존 그대로 |
| 모바일 웹 브라우저 | 기존과 동일 | 결제창 submit → ReturnURL | 기존 그대로(변경 없음) |
| iOS/Android 앱, 서버 앱 복귀 **꺼짐(기본)** | 기존과 동일(WapUrl/IspCancelUrl 없음) | 기존과 동일 | 기존과 동일 |
| iOS/Android 앱, 서버 앱 복귀 **켜짐** | + `WapUrl`, `IspCancelUrl` | 앱 WebView(`*.nicepay.co.kr` 허용) → 카드사 앱 호출 | 위 §3.4 |

## 6. 설정(운영 반영은 승인 후)
| 이름 | 값 | 기본 |
|---|---|---|
| `NICEPAY_APP_RETURN_ENABLED` | `true` | 없음(꺼짐) |
| `NICEPAY_APP_RETURN_SCHEME` | 승인된 scheme(제안 `mwhabitnicepay`) — Info.plist·Manifest·`NicepayAppReturn.*` 와 같아야 함 | 없음 |
네이티브 변경은 앱 **재빌드·스토어 재제출** 이 있어야 반영된다(server.url 모드라 웹 코드만 배포로 반영, `Info.plist`/`AndroidManifest.xml`/Swift/Java/`capacitor.config.ts` 는 아님).

## 7. 검증 결과
실제 NICEPAY 호출 0건. 격리 브라우저 QA 의 "앱 환경"은 Capacitor 공식 훅(`CapacitorCustomPlatform`)으로 흉내 낸 것이며 **네이티브(iOS/Android) 코드는 거기서 실행되지 않는다** — 네이티브 로직은 아래 별도 검증, 실기기는 BLOCKED.
| 구분 | 항목 | 결과 |
|---|---|---|
| 단위 | Vitest 전체 | **PASS** 254 파일 / 2944 테스트(1 파일·10 건너뜀은 기존). 신규: `nicepayAppReturn.test.ts`(서버 prepare·설정·form 검증·복귀 URL 위조 차단 17), `nicepayNativeParity.test.ts`(웹=iOS=Android 허용 목록·scheme·로그인 보호 11) |
| 정적 | 린트 / 프로덕션 빌드 / SQL 회귀(`test:sql`) | **PASS**(새 진단 0 / `next build` 성공 / 통과) |
| iOS | Swift 순수 로직 검사(`scripts/native/nicepayAppReturnCheck`, 복귀 URL 위조·이동 정책·scheme 판정 30여 항목) | **PASS** |
| iOS | `xcodebuild` iOS 시뮬레이터 Debug 빌드(코드서명 없음, 로컬 placeholder `GoogleService-Info.plist` 로 빌드 후 삭제) | **PASS** — 빌드 산출 Info.plist 에 URL scheme 3개(Google 2 + 복귀 1)·`LSApplicationQueriesSchemes` 29개 확인 |
| Android | JUnit `NicepayAppReturnTest` 9건(복귀 파서 위조 차단·이동 정책·scheme 판정·intent 대상 검증·market·허용 목록) | **PASS** |
| Android | `gradlew :app:assembleDebug` + 병합 Manifest 확인(deep link 1개, `queries` 24개) | **PASS** |
| 앱 환경 모의 | 격리 브라우저 QA RUN1(앱 복귀 서버 설정 **OFF=기본**): 기존 결제 QA 23 + 신규 8 | **31 passed**(기존 23 회귀 포함). 앱이어도 WapUrl/IspCancelUrl 없음, 결제는 서버 승인 후에만 완료 |
| 앱 환경 모의 | RUN2(설정 **ON**, 로컬 QA 서버 한정): 신규 8 | **8 passed** — ios/android 힌트에서 form 에 WapUrl/IspCancelUrl(서버 scheme + 주문 UUID), ReturnURL 은 서버 경로 그대로, 비밀 필드 없음, 승인 1회·수강권 1개 |
| 앱 환경 모의 | 복귀 시나리오 | pending 주문 복귀 → "완료" 안 보임 / 존재하지 않는·형식 불량·SQL 문자열 orderId / 타인 세션 / 세션 없음 / **중복 복귀 2회**(수강권·승인 불변) / 완료 주문에 cancel 복귀(되돌려지지 않음) / **ISP 취소 복귀**(본인 pending 만 취소, 타인 주문 불변) / **인증 성공 후 승인 거절·무응답**(수강권 0, 주문 pending 복귀) — 전부 PASS |
| 결제 OFF | `paymentOff.spec`(코드 상수 false — 환경변수·게이트가 모두 켜져도 결제창·주문·승인 없음) | **4 passed** |
| 로그인 회귀 | `tests/e2e/auth`(이메일 로그인·세션 유지·재설정·소셜 로그인 콜백 실패 경로) 15 + Google URL scheme·SceneDelegate 처리 순서 정적 고정 | **PASS** (OAuth 실제 제공자 흐름·Kakao/Apple 네이티브는 BLOCKED — 외부 제공자·실기기 필요) |
| 결제·예약 회귀 | `tests/e2e/checkout` + `tests/e2e/reservation`(모의 결제 포함) | **44 passed / 5 skipped**(기존 skip) |
| 미수행 | 앱 백그라운드 전환·재시작(콜드 스타트) 실제 동작, 카드사 앱 미설치·취소 실제 동작 | **BLOCKED**(실기기/에뮬레이터+카드사 앱 필요). 로직은 JUnit·Swift 검사로 검증(콜드 스타트=현재 URL 없음 → 결과 화면 이동, 미설치=ISP 스토어/안내 문구, 취소=cancel 복귀) |
| 미수행 | 기존 주문 처리 회귀(`expired-order-qa` 16) | 이 브랜치의 변경과 무관한 경로(주문 처리 SQL·관리자 화면)라 재실행하지 않았다 — CI 의 `expired-order-qa.yml` 은 해당 경로가 바뀔 때만 실행 |
| 미수행 | 심사 화면 QA 7건 | PR #254(미병합) 소속 — 이 브랜치에는 없다. 겹치는 파일(`flow.ts`·`run.sh`)의 병합 가능성은 §2 참고 |


## 8. 아직 NICEPAY 기술지원 확인이 필요한 설정(BLOCKED — 추측해서 운영 적용하지 않음)
1. **WapUrl/IspCancelUrl 의 정확한 값 형식**: 문서에는 `nicepaysample://` 예시뿐. `scheme://nicepay/wap?orderId=…` 처럼 path/query 가 붙어도 되는지, 카드사 앱이 이를 그대로 호출하는지.
2. **가맹점 scheme 이름**: 제안 `mwhabitnicepay` 확정(앱스토어 제출 후 변경 불가 — 사용자 승인 필요).
3. **카드사 인증 페이지 도메인 목록**(`allowNavigation`): 목록 없이 `*` 를 열 수 없어 현재는 `*.nicepay.co.kr` 만. 인증 중 다른 호스트로 이동하면 Capacitor 가 바깥 브라우저로 넘긴다 → 실제 결제창 흐름에서 확인 필요.
4. 앱 호출 목록의 최신 여부(문서: "앱 정책·버전에 따라 변경"), iOS 에서 `canOpenURL` 대신 `open` 완료 핸들러로 미설치를 판단하는 방식이 공식 샘플과 호환되는지.
5. WebView 에서 `Referer`/쿠키(제3자 쿠키)·`cacheMode` 등 Android WebView 설정 요구(Capacitor 기본값과 차이) — 실기기 확인.
6. 모바일 승인 후 `ReturnURL` 이 앱 WebView 에서 HTTPS 서버로 도달하는지(실제 NICEPAY 인증 후).
7. **실기기(iOS/Android) 카드사 인증 성공·앱 복귀·콜드 스타트 복귀** — 실제 PG·카드·기기 필요, 현재 BLOCKED.

## 9. 별도 주의(PR #254 관련)
공식 문서 결제창 표: "GoodsName … 쌍따옴표, **대괄호 등 특수기호는 별도 문의**". #254 의 `toNicepayGoodsName` 은 대괄호를 허용한다(상품명 "[QA] …"). NICEPAY 확인 전에는 대괄호·특수기호를 공백으로 바꾸는 것이 안전하다 — #254 후속 수정 항목(이 브랜치는 #254 를 수정하지 않았다, TODO 기록).

## 10. 승인이 필요한 항목
앱 scheme 확정과 운영 설정(`NICEPAY_APP_RETURN_*`) / 네이티브 재빌드·스토어 제출 / 카드사 도메인·`allowNavigation` 확장 / 결제 활성화(별도 절차 `docs/payments/NICEPAY_CARD_REVIEW_FINAL_20261030.md` 6.3) — 이번 브랜치에서는 어느 것도 하지 않았다.
