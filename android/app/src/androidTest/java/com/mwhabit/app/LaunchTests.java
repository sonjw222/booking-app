package com.mwhabit.app;

import static org.junit.Assert.assertTrue;

import androidx.lifecycle.Lifecycle;
import androidx.test.ext.junit.rules.ActivityScenarioRule;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import org.junit.Rule;
import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * Automated QA Foundation Batch(2026-09-18) — 요청 2-A/9(hardware back)/키보드/background-foreground.
 */
@RunWith(AndroidJUnit4.class)
public class LaunchTests {

    @Rule
    public ActivityScenarioRule<MainActivity> activityRule = new ActivityScenarioRule<>(MainActivity.class);

    @Test
    public void appLaunchesAndShowsHome() {
        TestSupport.waitForInitialLoad();
        // app/page.tsx — .header 안의 .location(고정 문구)와 하단 nav .nav-item[href="/"]
        // (app/components/BottomNav.tsx)를 CSS selector로 직접 조회한다.
        assertTrue(
            "홈 화면 헤더(.header .location)를 찾지 못함",
            TestSupport.webElementExists(".header .location")
        );
        assertTrue(
            "하단 nav 홈 탭(a.nav-item[href='/'])을 찾지 못함",
            TestSupport.webElementExists("a.nav-item[href='/']")
        );
    }

    @Test
    public void bottomNavAlwaysPresent() {
        TestSupport.waitForInitialLoad();
        // 홈/알림/마이는 로그인 여부와 무관하게 항상 노출(app/components/BottomNav.tsx,
        // NAV-001 — 예약/내예약만 로그인+수강권 보유 시에만 노출).
        for (String href : new String[]{"/", "/notifications", "/mypage"}) {
            assertTrue(
                "하단 nav 탭(a.nav-item[href='" + href + "'])을 찾지 못함",
                TestSupport.webElementExists("a.nav-item[href='" + href + "']")
            );
        }
    }

    // 요청 2-F: background → foreground 복귀 후 화면 유지 확인. UiDevice로 홈 버튼을
    // 누르고 최근 앱 목록을 조작하는 방식은 RemoteException을 던지고(체크 예외) 기기별
    // 애니메이션 타이밍에 취약해서, ActivityScenario 공식 API인 moveToState()로 액티비티
    // 생명주기 자체를 직접 오가는 방식을 쓴다(Android 공식 테스트 문서 권장 패턴 —
    // CREATED=백그라운드, RESUMED=포그라운드).
    @Test
    public void foregroundAfterBackground() {
        TestSupport.waitForInitialLoad();
        assertTrue("백그라운드 진입 전 홈 화면 확인 실패", TestSupport.webElementExists(".header .location"));

        activityRule.getScenario().moveToState(Lifecycle.State.CREATED);
        try {
            Thread.sleep(1000);
        } catch (InterruptedException ignored) {
            Thread.currentThread().interrupt();
        }
        activityRule.getScenario().moveToState(Lifecycle.State.RESUMED);
        try {
            Thread.sleep(1000);
        } catch (InterruptedException ignored) {
            Thread.currentThread().interrupt();
        }

        assertTrue("포그라운드 복귀 후 홈 화면 유지 실패", TestSupport.webElementExists(".header .location"));
    }
}
