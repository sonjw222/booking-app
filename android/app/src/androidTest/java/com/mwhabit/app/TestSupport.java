package com.mwhabit.app;

import static androidx.test.espresso.web.sugar.Web.onWebView;
import static androidx.test.espresso.web.webdriver.DriverAtoms.clearElement;
import static androidx.test.espresso.web.webdriver.DriverAtoms.findElement;
import static androidx.test.espresso.web.webdriver.DriverAtoms.webClick;
import static androidx.test.espresso.web.webdriver.DriverAtoms.webKeys;

import androidx.test.espresso.web.model.Atom;
import androidx.test.espresso.web.sugar.Web;
import androidx.test.espresso.web.webdriver.Locator;
import androidx.test.platform.app.InstrumentationRegistry;

/**
 * Automated QA Foundation Batch(2026-09-18) — 공용 헬퍼.
 *
 * 이 앱은 Capacitor server.url 모드라 WebView가 실제 배포된 웹사이트를 그대로 띄운다
 * (로컬 번들 아님) — Espresso가 보는 "화면"은 전부 WebView 안의 웹 콘텐츠다.
 *
 * iOS(XCUITest)와 달리 Android는 espresso-web(WebDriver 스타일 "Atom" 기반)으로 실제
 * DOM을 CSS selector/id/xpath로 직접 조회할 수 있다 — accessibilityLabel/텍스트에
 * 의존할 필요가 없다(ios/App/AppUITests의 텍스트 기반 조회와 다른 이유는
 * docs/AUTOMATED_QA.md 참고). 이 앱의 기존 CSS 클래스(.login-submit, .search-input,
 * .nav-item 등)가 이미 개발자 전용 안정적 식별자라 새 data-testid/id를 웹 앱에 추가할
 * 필요가 없었다 — <a class="nav-item" href="/...">처럼 href 속성까지 조합하면 탭
 * 5개를 각각 구분할 수 있다.
 */
final class TestSupport {
    private TestSupport() {}

    static final class TestAccount {
        static String userAEmail() {
            return InstrumentationRegistry.getArguments().getString("TEST_USER_A_EMAIL", "");
        }
        static String userAPassword() {
            return InstrumentationRegistry.getArguments().getString("TEST_USER_A_PASSWORD", "");
        }
        static String managerAEmail() {
            return InstrumentationRegistry.getArguments().getString("TEST_MANAGER_A_EMAIL", "");
        }
        static String managerAPassword() {
            return InstrumentationRegistry.getArguments().getString("TEST_MANAGER_A_PASSWORD", "");
        }

        static boolean hasUserA() {
            return !userAEmail().isEmpty() && !userAPassword().isEmpty();
        }
        static boolean hasManagerA() {
            return !managerAEmail().isEmpty() && !managerAPassword().isEmpty();
        }
    }

    // WKWebView와 달리 Android WebView는 서버 왕복 로드가 끝나기 전에 Espresso가 DOM을
    // 조회하면 "요소가 아직 없음"으로 바로 실패할 수 있다 — Espresso 자체의 idling
    // 동기화가 네트워크 요청까지는 못 기다려주므로, 최초 로드 직후에는 약간의 유예를
    // 둔다. 이후 각 findElement()는 espresso-web이 실패 시 자동 재시도하지 않으므로
    // 엘리먼트 존재를 기다리는 로직은 각 테스트에서 필요하면 별도 폴링으로 감싼다.
    static void waitForInitialLoad() {
        try {
            Thread.sleep(4000);
        } catch (InterruptedException ignored) {
            Thread.currentThread().interrupt();
        }
    }

    // app/login/page.tsx의 이메일 로그인 폼만 자동화한다 — Google/Apple/Kakao/Naver 등
    // 외부 OAuth는 절대 자동화하지 않는다(요청 4번 원칙).
    static void loginWithEmail(String email, String password) {
        onWebView()
            .withElement(findElement(Locator.CSS_SELECTOR, "input[type='email']"))
            .perform(clearElement())
            .perform(webKeys(email));

        onWebView()
            .withElement(findElement(Locator.CSS_SELECTOR, "input[type='password']"))
            .perform(clearElement())
            .perform(webKeys(password));

        // 주의: .login-submit 클래스는 이 화면에 유일하다(app/login/page.tsx —
        // 상단 모드 탭은 .mode-tab 클래스라 겹치지 않음, iOS 쪽처럼 텍스트 "로그인"이
        // 두 엘리먼트에 걸리는 문제 자체가 CSS 클래스 selector를 쓰면 애초에 없다 —
        // Android가 Locator.CSS_SELECTOR를 쓸 수 있어서 얻는 이점).
        onWebView()
            .withElement(findElement(Locator.CSS_SELECTOR, "button.login-submit"))
            .perform(webClick());

        try {
            Thread.sleep(3000);
        } catch (InterruptedException ignored) {
            Thread.currentThread().interrupt();
        }
    }

    // 엘리먼트 존재 여부만 확인(클릭/입력 없이) — Web.WebInteraction의 존재 확인은
    // findElement 자체가 없으면 예외를 던지므로 boolean으로 감싼다.
    static boolean webElementExists(String cssSelector) {
        try {
            onWebView().withElement(findElement(Locator.CSS_SELECTOR, cssSelector));
            return true;
        } catch (Throwable t) {
            return false;
        }
    }

    // Android Runtime QA Repair(2026-09-19) — 고정 Thread.sleep 뒤 한 번만 확인하는
    // 대신 폴링한다. 실기기(SM-T975N)로 실측: 검색처럼 실제 네트워크 왕복(Supabase
    // 쿼리)이 끝나야 결과가 그려지는 화면은, 고정 2초 뒤 딱 한 번 조회하는 시점에 아직
    // 응답이 안 와 있으면 findElement의 Atom 평가 자체가 일시적으로 실패한다("Atom
    // evaluation returned null" — WebView가 요청 중간 상태라 JS 브릿지 평가가 잠깐
    // 불안정한 것, 셀렉터가 잘못됐다는 뜻이 아님). 셀렉터/검증 기준을 느슨하게 풀지
    // 않고, 짧은 간격으로 재시도해 "그 순간 마침 준비 안 됨"으로 인한 flaky 실패만
    // 줄인다 — 결과가 timeoutMs 안에 끝내 안 나타나면 여전히 false(실패 처리)다.
    static boolean waitForAnyElement(long timeoutMs, String... cssSelectors) {
        long deadline = System.currentTimeMillis() + timeoutMs;
        do {
            for (String sel : cssSelectors) {
                if (webElementExists(sel)) return true;
            }
            try {
                Thread.sleep(300);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return false;
            }
        } while (System.currentTimeMillis() < deadline);
        return false;
    }

    // Android Runtime QA Repair(2026-09-19) — 회원 nav는 뷰포트 breakpoint에 따라 두
    // 컨테이너가 DOM엔 항상 둘 다 있고 CSS display:none으로 한쪽만 보인다
    // (app/globals.css "Responsive workspace shell", app/components/BottomNav.tsx):
    //   - <768px: .bottom-nav 안의 a.nav-item[href=...]
    //   - >=768px(태블릿 rail/데스크톱 사이드바): .member-desktop-nav 또는
    //     .workspace-sidebar 안의 a.desktop-nav-item[href=...] (둘 다 같은 클래스명 재사용)
    // 실기기(예: SM-T975N, 태블릿 rail 폭)에서 mobile 쪽 selector로 findElement는
    // 성공하지만(DOM엔 존재) webClick()은 WebDriver 표준 동작대로 "안 보이는 엘리먼트"
    // 예외(status 11)를 던진다 — 그래서 정확한 px 값을 여기 하드코딩해 CSS breakpoint와
    // 따로 판단하지 않는다(그 값이 CSS와 어긋나면 다시 깨짐). 대신 실제로 클릭이 먹히는
    // 쪽을 순서대로 시도한다 — 이게 "지금 실제로 보이는" 엘리먼트라는 뜻이다.
    static void clickFirstVisible(String... cssSelectors) {
        Throwable last = null;
        for (String sel : cssSelectors) {
            try {
                onWebView().withElement(findElement(Locator.CSS_SELECTOR, sel)).perform(webClick());
                return;
            } catch (Throwable t) {
                last = t;
            }
        }
        throw new AssertionError(
            "다음 selector 중 실제로 보이면서 클릭 가능한 엘리먼트를 찾지 못함: " + String.join(", ", cssSelectors),
            last
        );
    }

    // 회원 nav 탭(홈/예약/내예약/알림/마이)을 breakpoint와 무관하게 클릭한다 — mobile
    // bottom-nav와 tablet/desktop rail 두 selector를 순서대로 시도.
    static void clickNavTab(String href) {
        clickFirstVisible(
            "a.nav-item[href='" + href + "']",
            "a.desktop-nav-item[href='" + href + "']"
        );
    }

    // "이 nav 탭이 지금 화면에 있는가"(예: NAV-001 조건부 노출 확인용) — mobile/desktop
    // 두 selector 중 하나라도 DOM에 있으면 그 탭 자체는 노출된 것이다(두 nav 컨테이너
    // 모두 같은 조건(showMembershipTabs)으로 렌더링되므로, 조건부로 아예 렌더링 안 된
    // 경우엔 두 selector 모두 존재하지 않는다 — CSS breakpoint로 "안 보이기만" 하는
    // 경우와는 구분된다).
    static boolean navTabAvailable(String href) {
        return webElementExists("a.nav-item[href='" + href + "']")
            || webElementExists("a.desktop-nav-item[href='" + href + "']");
    }
}
