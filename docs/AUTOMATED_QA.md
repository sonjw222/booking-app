# 자동 UI QA — iOS XCUITest / Android Espresso / Firebase Test Lab

Automated QA Foundation Batch(2026-09-18)에서 신설. 목적: 모하빗의 핵심 사용자 플로우를
iOS/Android 네이티브 UI 테스트 프레임워크로 자동 검증하고, 나중에 Firebase Test Lab·
GitHub Actions에 쉽게 연결할 수 있는 형태로 정리한다.

이 문서는 `tests/unit`(vitest)·`tests/integration`(vitest, 실제 dev Supabase)·
`tests/e2e`(Playwright, 실제 브라우저)와는 **완전히 다른 층**을 다룬다 — 저 세 개는
전부 데스크톱 브라우저/Node 환경에서 웹 앱 자체를 테스트하고, 이 문서가 다루는 것은
**실제 iOS/Android 네이티브 앱 패키지(Capacitor로 감싼 WebView)** 를 실기기/에뮬레이터/
시뮬레이터에서 구동해 검증하는 것이다. 겹치는 검증도 있지만(탭 전환, safe-area 등)
"네이티브로 패키징됐을 때도 똑같이 동작하는지"는 이 계층에서만 확인할 수 있다.

## 0. 이 앱이 100% WebView라는 것이 테스트 전략에 미치는 영향

이 앱은 Capacitor `server.url` 모드다 — WKWebView/Android WebView가 실제 배포된
Next.js 사이트를 네트워크로 그대로 불러온다. 즉 "네이티브 UI"라고 부를 화면 자체가
없고, 모든 화면이 WebView 안의 DOM이다. 두 플랫폼의 UI 테스트 프레임워크가 그 DOM을
들여다보는 방식이 근본적으로 다르다는 걸 알아야 아래 테스트 코드가 왜 이렇게
생겼는지 이해할 수 있다.

- **iOS(XCUITest)**: WKWebView 안의 DOM 엘리먼트는 **accessibilityIdentifier로 찾을 수
  없다**(Apple/WebKit의 알려진 제약 — WebView 콘텐츠는 label/value/placeholder로만
  질의 가능, `app.webViews.buttons[...]`/`app.webViews.links[...]`/
  `app.webViews.textFields[...]`/`app.webViews.staticTexts[...]`처럼 "텍스트가 뭔지 +
  타입이 뭔지"로만 찾는다). `<a href>`(이 앱의 대부분 네비게이션 — Next.js `<Link>`
  포함)는 `.links`로, 진짜 `<button>`만 `.buttons`로 잡힌다. 이 앱은 다국어 전환
  계획이 없는 한국어 단일 언어 앱이라(코드 전체 검색으로 확인함) 실제 한국어 문구를
  안정적인 조회 키로 그대로 쓴다 — `aria-label`로 새 영문 식별자를 덮어씌우는 방식은
  일부러 안 썼다. 이미 의미 있는 텍스트가 있는 엘리먼트에 `aria-label`을 새로 달면
  **VoiceOver가 읽어주는 실제 접근성 이름이 그 값으로 대체**돼(예: "홈" 탭에
  `aria-label="mwhabit.tab.home"`을 달면 VoiceOver가 "홈" 대신 그 영문 문자열을
  읽음) 실사용자 접근성이 오히려 나빠진다 — "실제 UI/UX 변경 금지" 원칙과 정면으로
  충돌해서 하지 않았다.
- **Android(Espresso-Web)**: 다행히 Android는 훨씬 나은 공식 API가 있다 —
  **espresso-web**(`androidx.test.espresso:espresso-web`)의 `onWebView()`는
  WebDriver 스타일 "Atom"으로 **진짜 DOM 질의**(`Locator.CSS_SELECTOR`,
  `Locator.ID`, `Locator.XPATH` 등)를 할 수 있다. 이 앱의 기존 CSS 클래스
  (`.login-submit`, `.search-input`, `.nav-item`, `.manager-mode-switch`,
  `.mgr-mode-switch`, `.mgr-mode-bar` 등)가 이미 개발자 전용 안정적 식별자라 —
  href 속성까지 조합하면(`a.nav-item[href="/reservation"]`) 탭 5개도 각각 정확히
  구분된다 — **새 `id`/`aria-label`을 웹 앱에 하나도 추가하지 않았다**. 사용자
  요청은 `mwhabit.tab.home` 같은 네이밍 컨벤션 예시를 줬지만, 실제로는 그런 새 식별자
  없이도 기존 클래스만으로 충분해서 웹 앱 코드는 이번 배치에서 한 줄도 안 바뀌었다
  (안전성·회귀 위험 최소화 관점에서 더 나은 선택으로 판단함).

## 1. iOS — XCUITest

### 구조

- 타겟: `AppUITests`(신규, `ios/App/App.xcodeproj/project.pbxproj`에 새
  `PBXNativeTarget`으로 추가 — 기존 `App` 타겟은 전혀 안 건드림).
- 공유 스킴: `ios/App/App.xcodeproj/xcshareddata/xcschemes/App.xcscheme`(신규 —
  이 프로젝트에 지금까지 커밋된 공유 scheme이 없었음. Xcode가 매번 로컬에서
  자동 생성하던 것에만 의존하고 있었음). `App` 타겟 Build/Run/Archive는 기존과
  동일하게 최소 구성만 담고, `AppUITests`를 Test Action에 추가.
- 소스: `ios/App/AppUITests/`
  - `TestSupport.swift` — 공용 헬퍼(`TestAccount`가 환경변수 읽기, `loginWithEmail()`,
    `assertExists()`, `waitForWebContent()`).
  - `LaunchTests.swift` — 앱 실행/첫 화면(요청 2-A), background→foreground(요청 2-F).
  - `TabNavigationTests.swift` — 하단 탭 전환(요청 2-B).
  - `ManagerModeTests.swift` — 회원↔관리자 모드 전환(요청 2-C, `TEST_MANAGER_A_*` 필요).
  - `SearchTests.swift` — 검색 입력/결과(요청 2-D).
  - `SafeAreaTests.swift` — 헤더 frame이 상태바 영역과 안 겹치는지(요청 2-E, 아래
    "safe-area 검증의 한계" 참고).

### 로컬 실행

```bash
# 시뮬레이터 목록 확인(정확한 -destination 값 필요)
xcrun simctl list devices available

# 빌드만(컴파일/링크/패키징 검증 — 이 배치에서 실제로 검증한 범위)
xcodebuild build-for-testing \
  -project ios/App/App.xcodeproj -scheme App \
  -destination 'platform=iOS Simulator,name=iPhone 16,OS=latest'

# 실제 실행(시뮬레이터 부팅 필요)
xcodebuild test \
  -project ios/App/App.xcodeproj -scheme App \
  -only-testing:AppUITests \
  -destination 'platform=iOS Simulator,name=iPhone 16,OS=latest'
```

`App.entitlements`/`GoogleService-Info.plist`는 이 저장소에 커밋돼 있지 않다(사용자
로컬 전용, 실제 Apple/Firebase 콘솔 값 필요) — 로컬에서 빌드하려면 본인이 이미 갖고
있는 파일을 `ios/App/App/`에 두고 실행한다. 이 배치의 빌드 검증은 그 두 파일의
**임시 플레이스홀더**(진짜 값 아님, 컴파일 통과 전용)를 만들었다가 검증 직후
즉시 삭제하는 방식으로 했다(이전 배치들이 정립한 관례) — 커밋된 적 없음.

### 테스트 계정 env var

`TestSupport.swift`의 `TestAccount`가 `ProcessInfo.processInfo.environment`에서
`TEST_USER_A_EMAIL`/`TEST_USER_A_PASSWORD`/`TEST_MANAGER_A_EMAIL`/
`TEST_MANAGER_A_PASSWORD`를 읽는다 — `tests/e2e`(Playwright)와 완전히 같은 이름의
기존 테스트 전용 계정을 재사용한다(`.env.test.local.example` 참고, 새 계정 안 만듦).
`xcodebuild test`에 환경변수를 전달하려면 `TEST_RUNNER_` 접두사를 붙인다(Xcode 공식
관례 — 테스트 프로세스 안에서는 접두사 없이 그대로 보임):

```bash
TEST_RUNNER_TEST_USER_A_EMAIL="$TEST_USER_A_EMAIL" \
TEST_RUNNER_TEST_USER_A_PASSWORD="$TEST_USER_A_PASSWORD" \
TEST_RUNNER_TEST_MANAGER_A_EMAIL="$TEST_MANAGER_A_EMAIL" \
TEST_RUNNER_TEST_MANAGER_A_PASSWORD="$TEST_MANAGER_A_PASSWORD" \
xcodebuild test -project ios/App/App.xcodeproj -scheme App \
  -only-testing:AppUITests \
  -destination 'platform=iOS Simulator,name=iPhone 16,OS=latest'
```

값이 없으면 로그인이 필요한 테스트(`ManagerModeTests`, `SafeAreaTests`의 예약/관리자
케이스)는 `XCTSkip`으로 건너뛴다 — 실패로 안 뜸.

### 이번 배치에서 실제로 검증한 것 / 못한 것

- ✅ `xcodebuild build-for-testing`(Debug, `generic/platform=iOS Simulator`) —
  **BUILD SUCCEEDED**. 새 타겟/스킴/pbxproj 편집이 실제 SDK 기준으로 컴파일·링크·
  패키징(`AppUITests-Runner.app`)까지 된다는 뜻.
- ❌ 실제 테스트 실행(pass/fail) — 이 샌드박스엔 부팅된 시뮬레이터·네트워크로
  닿는 실제 백엔드·테스트 계정이 없어서 못 했다. `app.webViews.buttons["로그인"]`처럼
  "상단 모드 탭과 제출 버튼이 텍스트가 같아 DOM 순서로 마지막 매치를 쓰는" 부분 등
  실기기 없이는 100% 확신할 수 없는 지점이 있다 — 처음 실행 시 특히 주의 깊게 볼 것.

### safe-area 검증의 한계

`SafeAreaTests.swift`는 `XCUIElementTypeQueryProvider.statusBars`(Apple 공식 API)로
실제 상태바 frame을 얻어 헤더 엘리먼트의 `frame.minY`와 비교한다 — 픽셀 단위로
"상태바 영역 안으로 파고들었는지"를 실제로 검증할 수 있는 몇 안 되는 방법이다.
다만 기기/OS 조합에 따라 `statusBars` 쿼리가 항상 안정적으로 하나만 매치한다는
보장은 없어(멀티 윈도우, Dynamic Island 등) 실기기에서 최초 실행 시 재확인 필요.

## 2. Android — Espresso / UI Automator

### 구조

- `android/app/src/androidTest/java/com/mwhabit/app/`
  - `TestSupport.java` — 공용 헬퍼(`TestAccount`, `loginWithEmail()`,
    `webElementExists()`).
  - `LaunchTests.java` — 앱 실행/첫 화면, 하단 nav 항상 노출 확인, background↔
    foreground(`ActivityScenario.moveToState()` 공식 API 사용 — `UiDevice`로 홈/최근
    앱을 조작하는 방식은 `RemoteException`(checked)을 던지고 기기별 애니메이션
    타이밍에 취약해서 안 씀).
  - `TabNavigationTests.java` — 탭 전환 + **hardware back으로 이전 탭에 안 돌아가는지**
    (Batch 6/7의 replace 네비게이션 정책 회귀 테스트).
  - `ManagerModeTests.java` — 회원↔관리자 모드 전환(`TEST_MANAGER_A_*` 필요).
  - `SearchTests.java` — 검색 입력/결과 + 키보드 닫기(`Espresso.pressBack()`).
  - `SafeAreaTests.java` — 헤더/하단 nav/관리자 모드 바 존재 확인(아래 한계 참고).
- 정리한 것: `android/app/src/androidTest/java/com/getcapacitor/myapp/
  ExampleInstrumentedTest.java`, `android/app/src/test/java/com/getcapacitor/myapp/
  ExampleUnitTest.java`(원래 Capacitor 템플릿 기본 보일러플레이트, 패키지가 실제
  앱 패키지 `com.mwhabit.app`가 아니라 `com.getcapacitor.myapp`/`com.getcapacitor.app`
  라 실행됐으면 그 자체로 실패했을 죽은 코드) — 삭제.

### 의존성

`android/app/build.gradle`에 추가(전부 dl.google.com의 공식 maven-metadata.xml로
최신 stable 버전 확인함, 추측 안 함):

```groovy
androidTestImplementation "androidx.test.espresso:espresso-web:$androidxEspressoCoreVersion" // 3.7.0, espresso-core와 같은 릴리스 트레인
androidTestImplementation "androidx.test.uiautomator:uiautomator:$androidxTestUiAutomatorVersion" // 2.4.0
androidTestImplementation "androidx.test:rules:$androidxTestRulesVersion" // 1.7.0
```

### 알아둬야 할 빌드 이슈 하나(고쳤음)

`androidx.test.uiautomator`/`espresso-web`을 처음 추가하고 실제 instrumentation
테스트 APK를 패키징(`assembleDebugAndroidTest`)해보니 "Duplicate class" 빌드 실패가
났다 — 원인은 새로 추가한 라이브러리가 아니라, **이전 배치(release-blocker Google
네이티브 로그인)에서 추가된 `com.google.android.libraries.identity.googleid:
googleid:1.2.0`**이 옛 분리 Kotlin stdlib 아티팩트(`kotlin-stdlib-jdk7`/
`kotlin-stdlib-jdk8`, Kotlin 1.8부터 `kotlin-stdlib` 본체에 이미 합쳐짐)를 전이
의존성으로 끌어와서였다(`./gradlew :app:dependencies`로 직접 추적 확인함). 기존
`assembleDebug`/`assembleRelease`는 이 중복 검사에 안 걸려 지금까지 드러나지
않았을 뿐 — 이번이 이 프로젝트에서 처음으로 실제 instrumentation 테스트 APK를
패키징한 것이라 처음 드러났다. `android/build.gradle`의 `allprojects` 블록에
`kotlin-stdlib-jdk7`/`kotlin-stdlib-jdk8` 제외 규칙을 추가해 해결(jdk7/jdk8 확장
함수는 이미 `kotlin-stdlib` 안에 있어 동작에 영향 없는 순수 중복 제거 — Google
로그인 기능 자체는 안 건드림).

### 로컬 실행

```bash
npx cap sync android

# 빌드만(컴파일/링크/패키징 검증 — 이 배치에서 실제로 검증한 범위)
cd android && ./gradlew assembleDebugAndroidTest

# 실제 실행(에뮬레이터/실기기 연결 필요)
cd android && ./gradlew connectedDebugAndroidTest
```

### 테스트 계정 env var

Android는 iOS의 `TEST_RUNNER_` 접두사 같은 표준 메커니즘이 없어서, **Gradle 설정
시점에 호스트 환경변수를 읽어 instrumentation 실행 인자로 주입**하는 방식을 쓴다
(`android/app/build.gradle`의 `defaultConfig.testInstrumentationRunnerArguments`):

```bash
export TEST_USER_A_EMAIL=... TEST_USER_A_PASSWORD=...
export TEST_MANAGER_A_EMAIL=... TEST_MANAGER_A_PASSWORD=...
cd android && ./gradlew connectedDebugAndroidTest
```

테스트 코드는 `InstrumentationRegistry.getArguments().getString("TEST_USER_A_EMAIL", "")`
로 읽는다(`TestSupport.TestAccount`). 값이 없으면 빈 문자열이 전달되고,
`org.junit.Assume.assumeTrue(...)`로 해당 테스트를 스킵(실패 아님)한다.

### 이번 배치에서 실제로 검증한 것 / 못한 것

- ✅ `./gradlew assembleDebug`/`assembleRelease`/`compileDebugAndroidTestSources`/
  `assembleDebugAndroidTest` 전부 **BUILD SUCCESSFUL**. 새 Espresso-Web/UI Automator
  코드가 실제 의존성 기준으로 컴파일되고, 진짜 instrumentation 테스트 APK
  (`android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk`)까지
  패키징된다는 뜻.
- ❌ 실제 테스트 실행(pass/fail) — 이 샌드박스엔 에뮬레이터/실기기가 없어서
  `connectedDebugAndroidTest`는 못 돌렸다. iOS와 동일한 한계.

### safe-area 검증의 한계(iOS보다 더 제한적)

espresso-web의 공개 DSL(`DriverAtoms`)은 "임의 JS를 실행해
`getBoundingClientRect()` 같은 숫자를 돌려받아 assert"하는 것을 문서화된 방식으로
지원하지 않는다(WebView 인스턴스에 직접 접근하는 비공식 우회는 가능하지만, 실기기
검증 없이 그런 우회를 넣는 건 "검증 안 된 체크를 검증됐다고 주장"하는 셈이라
넣지 않았다). 그래서 Android `SafeAreaTests.java`는 iOS처럼 "헤더 frame이 상태바
밖에 있는지" 픽셀 단위까지는 못 가고, "헤더/하단 nav/관리자 모드 바 엘리먼트가
DOM에 실제로 존재하는지"까지만 확인한다 — 겹침 자체의 최종 판정은 여전히 사람이
직접 보는 실기기 QA 체크리스트 영역이다.

## 3. Firebase Test Lab

이번 배치에서 실제로 Test Lab에 제출하지는 않았다(유료 실행, 사용자 확인 필요) —
아래는 준비된 산출물과 그대로 실행 가능한 명령이다.

### Android

```bash
npx cap sync android
cd android
./gradlew assembleDebug assembleDebugAndroidTest
```

산출물:
- 앱 APK: `android/app/build/outputs/apk/debug/app-debug.apk`
- 테스트 APK: `android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk`

```bash
gcloud firebase test android run \
  --type instrumentation \
  --app android/app/build/outputs/apk/debug/app-debug.apk \
  --test android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk \
  --device model=Pixel8,version=34,locale=ko_KR,orientation=portrait \
  --timeout 10m \
  --environment-variables TEST_USER_A_EMAIL=...,TEST_USER_A_PASSWORD=...
```

(`--environment-variables`로 넘긴 값은 `testInstrumentationRunnerArguments`처럼
`InstrumentationRegistry.getArguments()`로 읽힌다 — gcloud 공식 문서 기준.)

### iOS

```bash
xcodebuild build-for-testing \
  -project ios/App/App.xcodeproj -scheme App \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath build-for-testlab
```

`build-for-testing`은 `.xctestrun` 파일과 `Products/` 디렉터리를 만든다(Test Lab이
요구하는 정확한 구조). 둘 다 하나의 zip으로 묶어 제출한다:

```bash
cd build-for-testlab/Build/Products
zip -r ../../../App-Tests.zip . \
  $(find . -maxdepth 1 -name "*.xctestrun")

gcloud firebase test ios run \
  --test App-Tests.zip \
  --device model=iphone15pro,version=17.5,locale=ko_KR,orientation=portrait \
  --timeout 10m
```

## 4. 실패 산출물 위치

- **iOS**: `xcodebuild test`는 기본적으로 DerivedData 아래
  `Logs/Test/*.xcresult`에 결과 번들을 남긴다(`-resultBundlePath`로 위치 지정
  가능). 실패한 테스트는 `.xcresult` 안에 스크린샷이 자동 첨부된다(Xcode 공식
  동작) — `xcrun xcresulttool get --path <bundle>.xcresult --format json`으로
  CI 로그에서도 요약을 뽑을 수 있다.
- **Android**: `./gradlew connectedDebugAndroidTest` 결과는
  `android/app/build/reports/androidTests/connected/`(HTML 리포트),
  `android/app/build/outputs/androidTest-results/connected/`(XML, JUnit 형식)에
  남는다(AGP 표준 경로, 이 배치에서 `assembleDebugAndroidTest`까지만 실행해봐서
  `reports/androidTests`는 아직 안 생겼다 — `connectedDebugAndroidTest`를 실제
  실행해야 채워짐). 실패 시 logcat은 `adb logcat`으로 별도 수집 필요(Espresso
  자체는 logcat을 자동 첨부하지 않음).

## 5. 자주 생기는 오류

- **테스트가 "실패"가 아니라 "skipped"로 뜸** → 정상. `TEST_USER_A_EMAIL` 등 계정
  env var가 없으면 의도적으로 건너뛴다(요청 8번 "secrets 없으면 graceful skip").
- **WebView 안 콘텐츠를 못 찾음(iOS: "No matches found", Android:
  `NoMatchingViewException`/`findElement` 실패)** → 십중팔구 한국어 문구가 코드에서
  바뀌었기 때문이다. 실패 메시지에 어떤 텍스트/selector를 찾고 있었는지 남기도록
  작성했으니(`assertExists()`/`webElementExists()`), 그 값으로 해당 페이지
  소스에서 실제 현재 문구를 다시 확인할 것 — 절대 추측으로 문구를 고치지 말고
  `app/` 소스의 실제 현재 텍스트를 확인.
- **시뮬레이터/에뮬레이터가 안 떠 있음** → iOS는 `xcrun simctl boot <UDID>`, Android는
  `emulator -avd <name>` 또는 Android Studio Device Manager로 먼저 부팅.
- **앱이 대상 기기에 설치가 안 돼 있음** → `xcodebuild test`/`connectedAndroidTest`는
  자동으로 설치하지만, 이전 실행이 비정상 종료됐으면 수동으로 제거
  (`xcrun simctl uninstall booted com.mwhabit.app` /
  `adb uninstall com.mwhabit.app`) 후 재시도.
- **로그인 테스트가 "로그인" 텍스트 모호성으로 엉뚱한 버튼을 누름(iOS만 해당)** —
  `app/login/page.tsx`의 상단 모드 탭과 제출 버튼이 둘 다 "로그인" 텍스트를 쓴다.
  iOS `TestSupport.swift`는 DOM에 늦게 렌더링되는 제출 버튼을 "마지막 매치"로
  가정해 선택한다 — 이 가정이 실기기에서 안 맞으면(레이아웃이 바뀌는 등)
  `LaunchTests`/`ManagerModeTests`의 로그인 관련 테스트가 엉뚱한 곳을 누를 수
  있다. Android는 CSS 클래스(`button.login-submit`)로 정확히 구분해서 이 문제가
  없다.

## 6. 네이티브/웹 테스트 계층 요약

| 계층 | 도구 | 실행 환경 | 검증 대상 |
|---|---|---|---|
| `tests/unit` | Vitest | Node | 순수 함수/소스 구조 |
| `tests/integration` | Vitest | Node + 실제 dev Supabase | RPC/RLS 왕복 |
| `tests/e2e` | Playwright | 헤드리스 Chromium(데스크톱) | 웹 앱 자체 |
| **`ios/App/AppUITests`** | **XCUITest** | **iOS 시뮬레이터/실기기** | **네이티브 패키징된 앱** |
| **`android/app/src/androidTest`** | **Espresso/UI Automator** | **Android 에뮬레이터/실기기** | **네이티브 패키징된 앱** |
