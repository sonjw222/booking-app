package com.mwhabit.app;

import static androidx.test.espresso.web.sugar.Web.onWebView;
import static androidx.test.espresso.web.webdriver.DriverAtoms.findElement;
import static androidx.test.espresso.web.webdriver.DriverAtoms.webClick;
import static org.junit.Assert.assertTrue;

import androidx.test.espresso.Espresso;
import androidx.test.espresso.web.webdriver.Locator;
import androidx.test.ext.junit.rules.ActivityScenarioRule;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import org.junit.Rule;
import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * Automated QA Foundation Batch(2026-09-18) — 요청 2-B: 하단 탭 전환. 요청 5(네비게이션):
 * 탭 전환 후 hardware back으로 이전 탭에 돌아가지 않는지(Batch 6/7 replace 정책,
 * lib/navState.ts / app/components/BottomNav.tsx replace prop).
 */
@RunWith(AndroidJUnit4.class)
public class TabNavigationTests {

    @Rule
    public ActivityScenarioRule<MainActivity> activityRule = new ActivityScenarioRule<>(MainActivity.class);

    @Test
    public void tapNotificationsTab() {
        TestSupport.waitForInitialLoad();
        onWebView()
            .withElement(findElement(Locator.CSS_SELECTOR, "a.nav-item[href='/notifications']"))
            .perform(webClick());
        try { Thread.sleep(2000); } catch (InterruptedException ignored) { Thread.currentThread().interrupt(); }

        // app/notifications/page.tsx — .noti-head가 최상단 헤더.
        assertTrue("'알림' 탭 전환 후 알림 화면(.noti-head)을 찾지 못함", TestSupport.webElementExists(".noti-head"));
    }

    @Test
    public void tapMyPageTab() {
        TestSupport.waitForInitialLoad();
        onWebView()
            .withElement(findElement(Locator.CSS_SELECTOR, "a.nav-item[href='/mypage']"))
            .perform(webClick());
        try { Thread.sleep(2000); } catch (InterruptedException ignored) { Thread.currentThread().interrupt(); }

        // 비로그인이면 로그인 유도(.primary-btn[href='/login']), 로그인 상태면
        // .profile-block(app/mypage/page.tsx) — 둘 중 하나만 확인해도 탭 전환 자체는
        // 검증됨(로그인 여부는 이 테스트의 관심사가 아님).
        boolean reachedSomeState =
            TestSupport.webElementExists(".profile-block") || TestSupport.webElementExists("a[href='/login']");
        assertTrue("'마이' 탭 전환 후 마이페이지 관련 화면에 도달하지 못함", reachedSomeState);
    }

    // 요청 5(네비게이션 정책 회귀): 탭 전환은 Batch 6/7의 replace 정책상 hardware
    // back으로 이전 탭에 돌아가면 안 된다(app/components/BottomNav.tsx의 <Link ... replace>).
    @Test
    public void tabSwitchDoesNotReturnOnHardwareBack() {
        TestSupport.waitForInitialLoad();
        assertTrue("초기 홈 화면 확인 실패", TestSupport.webElementExists(".header .location"));

        onWebView()
            .withElement(findElement(Locator.CSS_SELECTOR, "a.nav-item[href='/notifications']"))
            .perform(webClick());
        try { Thread.sleep(2000); } catch (InterruptedException ignored) { Thread.currentThread().interrupt(); }
        assertTrue("'알림' 탭으로 전환 실패", TestSupport.webElementExists(".noti-head"));

        Espresso.pressBack();
        try { Thread.sleep(1500); } catch (InterruptedException ignored) { Thread.currentThread().interrupt(); }

        // replace 정책이 살아있다면 홈(.header .location)으로 "돌아가지 않아야" 한다 —
        // 이미 홈 자체가 히스토리에서 대체됐으므로 hardware back은 알림 화면에 남아
        // 있거나(더 갈 곳이 없어 아무 반응 없음) 앱을 나가는 동작이어야 한다.
        assertTrue(
            "탭 전환 후 hardware back으로 이전 탭(홈)에 되돌아감 — replace 정책 회귀 의심",
            !TestSupport.webElementExists(".header .location") || TestSupport.webElementExists(".noti-head")
        );
    }
}
