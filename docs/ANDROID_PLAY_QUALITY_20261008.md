# Android Play Console 품질 경고 2건 — 원인 분석과 조치 (2026-10-08)

대상: Release 5 (1.0) AAB, targetSdk 36, minSdk 24, Capacitor 8.5.1(core/android), AGP 8.13.0, Gradle 8.14.3, JDK 21.

## 1. "DEX 코드 최적화가 기준점 미만" (난독화 1%, 2027-02 기한)
**원인(repo 근거)**: `android/app/build.gradle`의 release가 `minifyEnabled false`, `shrinkResources` 없음, `proguardFiles getDefaultProguardFile('proguard-android.txt')`(최적화 꺼진 규칙) — R8이 아예 안 돌았다. `proguard-rules.pro`는 주석뿐. 그래서 AAB에는 `d8.json`만 있고 mapping/`r8.json`이 없어 Play가 Optimization/Shrinking/R8 configuration을 "-"로 표시한다. DEX 총량은 로컬 unsigned `bundleRelease`로 **11,327,792 bytes(≈11.3MB)** — Play 실측 11.3MB와 일치(>10MB라 25% 기준 대상).

**조치(이 브랜치)**: release에 `minifyEnabled true`, `shrinkResources true`, `proguard-android-optimize.txt` + 좁은 `proguard-rules.pro`(SourceFile/LineNumberTable 유지 + 파일명 숨김만). 광범위 `-keep class **` 없음.

**로컬 unsigned `./gradlew :app:bundleRelease` 전/후(같은 소스)**
| 항목 | 전 | 후 |
|---|---|---|
| DEX 총량 | 11,327,792 B (classes.dex 8.6MB + classes2.dex 2.7MB) | 1,599,952 B (classes.dex 1개) |
| AAB | 10,307,710 B | 8,111,598 B |
| BUNDLE-METADATA | d8.json | **r8.json + proguard.map(12.6MB)** |
| 난독화된 클래스(mapping) | – | 2,185 / 2,370 (92%) |
| 제거된 코드 | – | usage.txt 32,042줄 |
R8 경고/누락 클래스 0건(추가 `-dontwarn` 불필요). Play가 각 비율(≥25%)을 어떻게 계산하는지는 repo에서 확정 불가 → **UNKNOWN, 다음 AAB 업로드 후 Play Console에서 확인**.

**keep 규칙이 필요한 곳(확인 결과)**
- Capacitor: `@CapacitorPlugin`·`extends Plugin` 전체·`@PluginMethod` — capacitor-android의 consumer 규칙이 이미 보장(앱 커스텀 플러그인 4개 포함, mapping에서 이름 유지 확인).
- WebView 브리지: `MessageHandler.postMessage`(`@JavascriptInterface`)는 난독화된 클래스 안에서 이름 유지, `androidBridge` 문자열 존재(DEX 확인).
- Firebase Messaging / ComponentDiscovery / FirebaseInitProvider, `androidx.credentials.playservices.CredentialProviderPlayServicesImpl`(리플렉션 로드), `androidx.startup`: 모두 이름 유지(각 AAR consumer 규칙).
- 매니페스트 컴포넌트(MainActivity, MwhabitMessagingService, FileProvider): AGP 자동 keep.
→ 추가 앱 규칙 불필요. 새 리플렉션 사용 코드/플러그인을 넣을 때만 좁게 추가.

**AGP 9.0 업그레이드는 하지 않는다**: Play 권고의 핵심은 "R8 사용"이지 AGP 버전이 아니다(AGP 8.13의 R8로 위 결과가 나옴). AGP 9는 Gradle 9와 DSL 변경이 필요해 Capacitor 8 템플릿과 어긋날 수 있어 별도 작업.

**릴리스 전 필수 실기기 테스트(R8 켠 release AAB/APK)**: Google/Kakao/Naver 로그인, 이메일 로그인/로그아웃, FCM 푸시(포그라운드/백그라운드/종료 상태 수신 + 알림 탭 이동 + 큰 아이콘), 푸시 토큰 등록, 캘린더 추가(CalendarEventPlugin), 앱 설정 열기(AppSettingsPlugin), 공유, 햅틱, 네트워크 상태, 스플래시 숨김, 상태바 스타일(라이트/다크 전환), 키보드 inset, 위치 권한, 파일 선택/업로드, 딥링크/뒤로가기, 결제 화면(PG OFF 상태), 크래시 시 Play Console 스택트레이스가 복원되는지(mapping 자동 업로드).

**로컬 검증 방법(서명 불필요)**: `android/local.properties`에 `sdk.dir`을 두고 `./gradlew :app:bundleRelease`(서명 속성이 없으면 unsigned AAB) → `unzip -l app-release.aab | grep -E 'base/dex/classes|BUNDLE-METADATA'`로 DEX 크기·r8.json 확인, `app/build/outputs/mapping/release/{mapping,usage,seeds,configuration}.txt`로 난독화/제거/keep 확인. (`capacitor-cordova-android-plugins` 모듈은 cap sync가 만드는 gitignored 디렉터리라 cap sync 없이 검증할 땐 빈 stand-in이 필요.)

## 2. "더 넓은 화면용으로 지원 중단된 API/파라미터" (Android 15 edge-to-edge)
**발생 위치**: Play가 지목한 `Window.getStatusBarColor/setStatusBarColor` ← `com.capacitorjs.plugins.statusbar.StatusBar.getStatusBarColorDeprecated/setStatusBarColorDeprecated`. **앱 코드가 아니라 `@capacitor/status-bar` 8.0.3 플러그인**이다.
- 앱 직접 native 코드(MainActivity, 4개 플러그인, 메시징 서비스), 매니페스트, styles/themes에는 `setStatusBarColor`/`setNavigationBarColor`/`setDecorFitsSystemWindows`/`layoutInDisplayCutoutMode`/`screenOrientation`/`resizeableActivity`/aspect-ratio 속성이 **없다**(grep 확인). `MainActivity`는 `EdgeToEdge.enable()` + `WindowInsetsCompat` 리스너(지원되는 API)를 쓴다.
- 앱의 JS는 `StatusBar.setStyle()`만 호출한다(`lib/nativeTheme.ts`) — 색 변경 API는 호출하지 않는다. 플러그인이 생성자/`setBackgroundColor`에서 deprecated 메서드를 SDK 분기(`shouldSetStatusBarColor`) 뒤에 두지만, Play는 코드 존재를 정적으로 잡는다.
- **버전 업그레이드로는 안 풀린다**: 최신 `@capacitor/status-bar` 8.0.4의 Java 소스는 8.0.3과 byte-identical(확인). Capacitor core/android는 8.5.1(최신 8.5.3) — core의 `SystemBars` 플러그인에는 deprecated 호출이 없다.

**권장(이번에는 코드 변경 없음)**: 플러그인을 지금 제거하지 않는다(상태바 overlay/safe-area 수정 이력 6차까지, iOS가 이 플러그인의 Swift `load()`에 의존). 단계별 계획:
1. (Android 한정) `StatusBar.setStyle` → Capacitor core `SystemBars.setStyle({ style, bar: StatusBar })`로 `lib/nativeTheme.ts`에서 플랫폼 분기(iOS는 기존 StatusBar 유지). 호스팅된 웹(server.url)이라 JS 변경은 설치된 앱(core 8.5.1 = SystemBars 포함)에도 즉시 적용되므로 롤백이 쉽다.
2. 그 다음 새 AAB에서 Android만 플러그인 제외: `capacitor.config.ts`의 `android.includePlugins`(플랫폼별 allowlist, Cap 3.0+) 또는 `cap sync` 결과 반영 — **cap sync가 필요하고 실기기 safe-area 검증이 필수**라 별도 작업/별도 AAB로 한다. 경고를 숨기는 lint disable은 쓰지 않는다.
3. Android 16 대형 화면: 매니페스트에 orientation/resizeable 제한이 없어 현재는 그대로 호환. 변경 시 태블릿(SM-T975N급)·폴더블 크기 변경(configChanges 이미 포함)을 같이 본다.

**회귀 위험(safe-area)**: 중간. 상단 inset은 `MainActivity`의 inset 리스너 + core SystemBars(`insetsHandling: css` 기본)+웹의 `env(safe-area-inset-*)`가 함께 만든다. SystemBars는 이미 core에서 동작 중이라 스타일만 옮기면 변화가 작지만, 플러그인 제거 단계는 아래를 실기기로 확인해야 한다: Android 14/15/16(target 36)의 라이트/다크, 상단·하단 safe-area, 로그인, 홈, 관리자 페이지, 하단 네비게이션, 키보드 열림, 태블릿 사이드바.

## Play Console에서 사용자가 확인할 것
- 새 AAB(R8 ON)를 내부 테스트 트랙에 올린 뒤 **앱 번들 탐색기/Android vitals → 앱 품질 권장사항**에서 "DEX 코드 최적화" 카드의 Obfuscation/Optimization/Shrinking 비율과 "R8 configuration"이 채워지는지 확인(반영에 시간이 걸릴 수 있음). 비율이 25% 미만이면 mapping/usage를 근거로 규칙을 점검.
- deobfuscation 파일(mapping)이 해당 버전에 자동 연결됐는지(출시 > 앱 번들 탐색기 > 다운로드 > 자산) 확인.
- "더 넓은 화면" 경고는 위 2단계의 새 AAB 이후에 사라지는지 확인(그 전에는 계속 표시되는 것이 정상).
