package com.mwhabit.app;

import static org.junit.Assert.assertTrue;

import androidx.lifecycle.Lifecycle;
import android.Manifest;
import androidx.test.ext.junit.rules.ActivityScenarioRule;
import androidx.test.rule.GrantPermissionRule;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import org.junit.Rule;
import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * Automated QA Foundation Batch(2026-09-18) — 요청 2-A/9(hardware back)/키보드/background-foreground.
 */
@RunWith(AndroidJUnit4.class)
public class LaunchTests {

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
