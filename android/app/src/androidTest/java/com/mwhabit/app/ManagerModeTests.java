package com.mwhabit.app;

import static androidx.test.espresso.web.sugar.Web.onWebView;
import static androidx.test.espresso.web.webdriver.DriverAtoms.findElement;
import static androidx.test.espresso.web.webdriver.DriverAtoms.webClick;
import static org.junit.Assert.assertTrue;
import static org.junit.Assume.assumeTrue;

import androidx.test.espresso.web.webdriver.Locator;
import android.Manifest;
import androidx.test.ext.junit.rules.ActivityScenarioRule;
import androidx.test.rule.GrantPermissionRule;
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

    // Android Runtime QA Repair(2026-09-19) — 실기기(Android 13+)는 POST_NOTIFICATIONS
    // 런타임 권한을 앱이 요청할 때 시스템 다이얼로그(GrantPermissionsActivity)를 띄운다.
    // 이 다이얼로그가 뜨는 동안 MainActivity가 포커스를 잃어 espresso-web의 Atom 평가가
    // "Atom evaluation returned null"로 반복 실패하는 걸 실기기로 재현·확정했다(타이밍에
    //
    // 따라 아무 테스트에서나 터질 수 있음 — 이 테스트 자체의 로직 문제가 아니었음). 표준
    // 공식 API인 GrantPermissionRule로 테스트 시작 전에 미리 권한을 승인해 다이얼로그
    // 자체가 뜨지 않게 한다 — @Rule(order=0)으로 ActivityScenarioRule보다 먼저 적용
    // (JUnit 4.13+ 순서 보장, 권한 부여가 액티비티 실행보다 먼저 끝나야 의미가 있음).
    @Rule(order = 0)
    public GrantPermissionRule permissionRule = GrantPermissionRule.grant(
        Manifest.permission.POST_NOTIFICATIONS,
        Manifest.permission.ACCESS_FINE_LOCATION,
        Manifest.permission.ACCESS_COARSE_LOCATION
    );

    @Rule(order = 1)
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

        TestSupport.clickNavTab("/mypage");
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
