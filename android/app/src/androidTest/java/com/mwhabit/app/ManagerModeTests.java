package com.mwhabit.app;

import static androidx.test.espresso.web.sugar.Web.onWebView;
import static androidx.test.espresso.web.webdriver.DriverAtoms.findElement;
import static androidx.test.espresso.web.webdriver.DriverAtoms.webClick;
import static org.junit.Assert.assertTrue;
import static org.junit.Assume.assumeTrue;

import androidx.test.espresso.web.webdriver.Locator;
import androidx.test.ext.junit.rules.ActivityScenarioRule;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import org.junit.Rule;
import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * Automated QA Foundation Batch(2026-09-18) — 요청 2-C: 회원 ↔ 관리자 모드 전환.
 *
 * TEST_MANAGER_A_EMAIL/PASSWORD가 없으면 건너뛴다(assumeTrue — JUnit에서 "실패"가 아닌
 * "skipped"로 리포트됨, iOS의 XCTSkip과 동일한 효과).
 */
@RunWith(AndroidJUnit4.class)
public class ManagerModeTests {

    @Rule
    public ActivityScenarioRule<MainActivity> activityRule = new ActivityScenarioRule<>(MainActivity.class);

    @Test
    public void switchToManagerModeAndBack() {
        assumeTrue(
            "TEST_MANAGER_A_EMAIL/PASSWORD가 설정되지 않아 건너뜀 — docs/AUTOMATED_QA.md 참고",
            TestSupport.TestAccount.hasManagerA()
        );
        TestSupport.waitForInitialLoad();
        TestSupport.loginWithEmail(TestSupport.TestAccount.managerAEmail(), TestSupport.TestAccount.managerAPassword());

        assertTrue("로그인 후 홈 화면 복귀 실패", TestSupport.webElementExists(".header .location"));

        onWebView()
            .withElement(findElement(Locator.CSS_SELECTOR, "a.nav-item[href='/mypage']"))
            .perform(webClick());
        try { Thread.sleep(2000); } catch (InterruptedException ignored) { Thread.currentThread().interrupt(); }

        // app/mypage/page.tsx — <a class="list-row manager-mode-switch" href="/manager">
        assertTrue(
            "'관리자 모드로 전환' 링크(.manager-mode-switch)를 찾지 못함 — 계정에 관리자 권한이 없을 수 있음",
            TestSupport.webElementExists("a.manager-mode-switch")
        );
        onWebView()
            .withElement(findElement(Locator.CSS_SELECTOR, "a.manager-mode-switch"))
            .perform(webClick());
        try { Thread.sleep(2000); } catch (InterruptedException ignored) { Thread.currentThread().interrupt(); }

        // app/manager/page.tsx — <div class="mgr-mode-bar">, 복귀 링크 <a class="mgr-mode-switch">
        assertTrue("관리자 홈 상단 바(.mgr-mode-bar)를 찾지 못함", TestSupport.webElementExists(".mgr-mode-bar"));
        assertTrue("'회원 모드로 전환' 링크(.mgr-mode-switch)를 찾지 못함", TestSupport.webElementExists("a.mgr-mode-switch"));

        onWebView()
            .withElement(findElement(Locator.CSS_SELECTOR, "a.mgr-mode-switch"))
            .perform(webClick());
        try { Thread.sleep(2000); } catch (InterruptedException ignored) { Thread.currentThread().interrupt(); }

        assertTrue("회원 모드 복귀 후 홈 화면 확인 실패", TestSupport.webElementExists(".header .location"));
    }
}
