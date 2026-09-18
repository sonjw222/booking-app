package com.mwhabit.app;

import static org.junit.Assert.assertTrue;

import androidx.test.espresso.Espresso;
import androidx.test.espresso.NoActivityResumedException;
import android.Manifest;
import androidx.test.ext.junit.rules.ActivityScenarioRule;
import androidx.test.rule.GrantPermissionRule;
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
    public void tapNotificationsTab() {
        TestSupport.waitForInitialLoad();
        TestSupport.clickNavTab("/notifications");
        try { Thread.sleep(2000); } catch (InterruptedException ignored) { Thread.currentThread().interrupt(); }

        // app/notifications/page.tsx — .noti-head가 최상단 헤더.
        assertTrue("'알림' 탭 전환 후 알림 화면(.noti-head)을 찾지 못함", TestSupport.webElementExists(".noti-head"));
    }

    @Test
    public void tapMyPageTab() {
        TestSupport.waitForInitialLoad();
        TestSupport.clickNavTab("/mypage");

        // 비로그인이면 로그인 유도(.primary-btn[href='/login']), 로그인 상태면
        // .profile-block(app/mypage/page.tsx) — 둘 중 하나만 확인해도 탭 전환 자체는
        // 검증됨(로그인 여부는 이 테스트의 관심사가 아님). 고정 sleep 대신 폴링(요청 11번,
        // SearchTests와 동일 근거 — 페이지 전환 후 렌더링 타이밍 편차를 흡수).
        boolean reachedSomeState = TestSupport.waitForAnyElement(6000, ".profile-block", "a[href='/login']");
        assertTrue("'마이' 탭 전환 후 마이페이지 관련 화면에 도달하지 못함", reachedSomeState);
    }

    // 요청 5(네비게이션 정책 회귀): 탭 전환은 Batch 6/7의 replace 정책상 hardware
    // back으로 이전 탭에 돌아가면 안 된다(app/components/BottomNav.tsx의 <Link ... replace>).
    @Test
    public void tabSwitchDoesNotReturnOnHardwareBack() {
        TestSupport.waitForInitialLoad();
        assertTrue("초기 홈 화면 확인 실패", TestSupport.webElementExists(".header .location"));

        TestSupport.clickNavTab("/notifications");
        try { Thread.sleep(2000); } catch (InterruptedException ignored) { Thread.currentThread().interrupt(); }
        assertTrue("'알림' 탭으로 전환 실패", TestSupport.webElementExists(".noti-head"));

        // replace 정책상 hardware back은 (a) 알림 화면에 그대로 남거나, (b) 더 갈 곳이
        // 없어 앱이 종료되거나(Capacitor BridgeActivity 기본 동작 — WebView가
        // canGoBack()==false면 super.onBackPressed()로 액티비티 종료) 둘 중 하나여야
        // 한다(주석 아래 assert와 동일 정책). 이 배치에서 실기기로 확인: (b)의 경우
        // Espresso.pressBack()이 자체적으로 NoActivityResumedException을 던진다(백 이후
        // RESUMED 상태인 액티비티가 하나도 없다는 뜻 — Espresso의 정상적인 안전장치이지
        // 테스트 인프라 결함이 아님). 이걸 실패로 취급하지 않는다 — "홈으로 돌아갔다면"
        // 애초에 이 예외 자체가 안 났을 것이므로(그랬다면 액티비티가 RESUMED로 남아있음),
        // 이 예외가 났다는 사실 자체가 이미 "이전 탭(홈)으로 안 돌아갔다"는 걸 증명한다 —
        // assertion을 느슨하게 만드는 게 아니라 정책상 허용된 결과를 정확히 반영하는 것.
        boolean appExitedOnBack = false;
        try {
            Espresso.pressBack();
        } catch (NoActivityResumedException e) {
            appExitedOnBack = true;
        }

        if (!appExitedOnBack) {
            try { Thread.sleep(1500); } catch (InterruptedException ignored) { Thread.currentThread().interrupt(); }
            assertTrue(
                "탭 전환 후 hardware back으로 이전 탭(홈)에 되돌아감 — replace 정책 회귀 의심",
                !TestSupport.webElementExists(".header .location") || TestSupport.webElementExists(".noti-head")
            );
        }
    }
}
