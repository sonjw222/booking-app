# iOS NICEPAY 결제창 상단 Safe Area 잘림 — 진단·수정 (2026-11-09)

기준 `c2c59bf5`(qa/nicepay-ios-nav-20261108, NICEPAY 호스트 허용) → 브랜치 `qa/nicepay-ios-safearea-20261109`. 실기기 QA(TestFlight 1.0.3 (8)): 결제창은 앱 안에서 열림·결제수단/카드사 목록 PASS, **상단 헤더와 X 닫기 버튼이 화면 위로 잘림 FAIL**.

## 확인된 원인
1. `capacitor.config.ts`: `ios.contentInset = "never"`, `StatusBar.overlaysWebView = true` → WKWebView 가 상태바·Dynamic Island 뒤까지 화면 전체를 덮고, 시스템은 WebView 콘텐츠에 안전 영역 inset 을 넣지 않는다. 모하빗 화면은 이를 CSS `env(safe-area-inset-*)` 로 직접 처리한다(`app/globals.css`).
2. NICEPAY 결제창은 외부 페이지다 — viewport-fit 이 없고 `env()` 도 쓰지 않아, 상단 고정 헤더·X 버튼이 y=0(상태바 뒤)에 그려진다. (c2c59bf5 이전에는 외부 Safari 로 나가서 이 문제가 드러나지 않았다.)
3. **iOS 26.5 시뮬레이터(iPhone 17 Pro Max, 실제 WKWebView·앱 번들)에서 재현·측정**: 안전 영역 상단 62px, 결제창 모의 페이지(viewport-fit 없음, 상단 고정 헤더 + 오른쪽 44px X 버튼)의 X 버튼 영역이 y=6~50px(`getBoundingClientRect`) → **안전 영역(0~62)과 겹침**, 시계·배터리 아이콘과 헤더가 겹쳐 보임(스크린샷 `before-*`). X 중심(y=28)은 상태바 영역 안이라 시스템의 상태바 탭(맨 위로 스크롤) 제스처와 터치가 겹칠 수 있다.

## 수정(최소·iOS 한정)
`ios/App/App/NavigationPolicyPlugin.swift` 에 `NicepaySafeAreaPolicy`(순수 판정) + `NicepaySafeAreaObserver`, `SceneDelegate.swift` 에서 WebView 생성 직후 연결.
- WebView 주소(KVO `url`)의 호스트가 NICEPAY(정확히 `pg-web`·`dc1-web`·`web`.nicepay.co.kr — `capacitor.config.ts` allowNavigation 과 같은 목록, 와일드카드 없음)이면 그동안에만 `scrollView.contentInsetAdjustmentBehavior = .always` → 시스템이 상단(Dynamic Island·상태바)·하단(홈 인디케이터)·가로 회전 시 좌우 안전 영역을 콘텐츠에 적용.
- 앱 origin(mwhabit.com)으로 돌아오면 **시작 시점의 값(.never)으로 복원**. 그 밖의 호스트(소셜 로그인 등)에서는 아무것도 바꾸지 않는다.
- 전역 StatusBar 설정·`capacitor.config.ts`·모하빗 CSS·NICEPAY 페이지 DOM/폼/카드 입력은 건드리지 않는다(DOM 주입·JS 실행 없음). Android 는 무관(Swift 파일만 변경).
- DEBUG 빌드에서만 QA 용으로 호스트 목록을 `plugins.NicepaySafeArea.hosts` 로 바꿀 수 있다(출시 빌드는 고정 목록).

## 검증
| 항목 | 결과 |
|---|---|
| 시뮬레이터(iPhone 17 Pro Max, iOS 26.5) 수정 전 | 재현: X 버튼 y=6~50 < 안전 영역 62, 시계·배터리와 겹침 |
| 수정 후 NICEPAY 모의 페이지 | `innerHeight` 956→860(상단 62 + 하단 34 inset 적용), 헤더·X 버튼이 상태바/Dynamic Island 아래에 완전히 표시, X 중심에 `elementFromPoint` 가 X 버튼 반환 |
| 모하빗 모의 화면(앱 origin) | 수정 전후 동일: `innerHeight` 956, `env(safe-area-inset-top)` 62, 레이아웃 불변 |
| 결제창 → 앱 복귀 | 복귀 후 `innerHeight` 956·env 62 로 원복(스크린샷 `return-to-app-restored.png`) |
| 단위/계약 테스트 | `tests/unit/iosNicepaySafeArea.test.ts` 5건 PASS — Swift 호스트 목록=allowNavigation 목록, 전역 설정 불변, 관찰자는 inset 동작 하나만 변경(StatusBar·frame·JS 주입 금지), DEBUG 전용 재정의, Android 무관, `swiftc` 로 컴파일·실행한 순수 판정(대소문자·유사 도메인·nil) |
| iOS Debug 빌드 | BUILD SUCCEEDED(시뮬레이터, 서명 없음) |
| 기존 안전 영역/상태바 회귀 | 전체 vitest 에 포함(아래 보고) |
| **가로 회전** | **BLOCKED** — 시뮬레이터 GUI 조작(키 입력)이 허용되지 않아 자동 회전 불가. 앱은 가로 방향을 지원하며(Info.plist), `.always` 는 UIKit 이 회전 시 좌우·상단 inset 을 다시 계산하는 시스템 동작이다 → 실기기 확인 항목 |
| **실제 NICEPAY 결제창·실기기** | **BLOCKED** — 실제 NICEPAY 페이지(헤더 구조는 NICEPAY 소유)는 시뮬레이터에서 검증하지 않았다(외부 페이지·카드 인증 금지). TestFlight 재빌드 후 확인 |

## 영향 분석
- 영향 범위: NICEPAY 3개 호스트에 있는 동안의 WebView 안전 영역 처리뿐. 앱 화면의 `env(safe-area-inset-*)` 처리와 이중 적용되지 않는다(NICEPAY 호스트에서만 inset 을 켜고, 앱 origin 에서는 복원).
- OAuth(소셜 로그인) 호스트·앱 링크·푸시·상태바 스타일 코드는 변경 없음. 모하빗 홈/센터/로그인/예약 화면은 `.never` 그대로.
- 결제창 안에서 NICEPAY 가 자체 모달을 `position: fixed` 로 전체 화면에 덮는 경우에도 inset 영역(상태바 뒤)은 WebView 밖이라 앱 배경색이 보인다(상태바 가독성 유지).
- 알려진 한계: 카드사 인증 페이지 등 NICEPAY 이후 단계의 다른 호스트는 허용 목록 밖이라(이번 범위 아님) 이 보정 대상이 아니다.

## 재빌드·재검증(TestFlight)
- **iOS 앱 재빌드·재설치 필요**(네이티브 Swift 변경).
- 확인: niceqa → A10TION 상품 → 결제 화면 → "카드 결제창 확인" → ① 헤더·X 가 상태바 아래에 완전히 보이는지(iPhone 17 Pro Max) ② X 탭으로 닫힘·앱 결제 화면 복귀 ③ 복귀 후 앱 화면 상단 여백 불변 ④ 가로 회전·뒤로가기 ⑤ 카드번호·인증 입력 없이 닫기, 신규 주문 없음.
