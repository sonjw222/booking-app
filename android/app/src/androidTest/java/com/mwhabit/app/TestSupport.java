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
}
