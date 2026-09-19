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
 * Automated QA Foundation Batch(2026-09-18) — 요청 3-H: safe-area/system-bars 구조를
 * 회귀 테스트할 수 있는 최소 골격.
 *
 * 중요한 한계(정직하게 기록 — docs/AUTOMATED_QA.md에도 동일하게 남김): espresso-web의
 * 공개 DSL(Atom/DriverAtoms)은 "임의 JS를 실행해 getBoundingClientRect() 같은 숫자
 * 결과를 돌려받아 assert하는" 것을 문서화된 방식으로 지원하지 않는다(WebView 인스턴스
 * 자체에 직접 접근하는 비공식 우회는 가능하지만 이 배치에서는 하지 않음 — 실기기
 * 검증 없이 그런 우회를 넣는 건 "검증되지 않은 체크를 검증됐다고 주장하는" 것과
 * 같아서 지양). 그래서 이 파일은 iOS SafeAreaTests.swift의 "헤더 frame이 상태바 영역
 * 밖에 있는지"까지는 못 가고, "MainActivity.java가 WindowInsetsCompat으로 padding을
 * 준 콘텐츠 뷰 안에서 헤더/하단 nav 엘리먼트가 실제로 존재하고 화면에 그려졌는지"까지만
 * 확인한다 — 겹침 자체의 픽셀 검증은 여전히 실기기 QA 체크리스트(사람이 직접 확인)
 * 영역으로 남는다.
 */
@RunWith(AndroidJUnit4.class)
public class SafeAreaTests {

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
    public void homeHeaderExists() {
        TestSupport.waitForInitialLoad();
        assertTrue(".header 존재 확인 실패(홈 화면)", TestSupport.webElementExists(".header"));
        assertTrue(".location(헤더 문구) 존재 확인 실패", TestSupport.webElementExists(".header .location"));
    }

    @Test
    public void bottomNavExists() {
        TestSupport.waitForInitialLoad();
        // app/globals.css — .bottom-nav는 position:fixed + bottom:max(16px,
        // env(safe-area-inset-bottom)). Android는 --floating-nav-clearance 계산에
        // 기대지 않고 MainActivity.java가 네이티브로 콘텐츠 뷰 자체에 시스템 바 크기만큼
        // padding을 이미 주고 있어(이 배치의 iOS 세션 노트 참고), 여기서는 nav 엘리먼트
        // 존재만 확인한다.
        assertTrue(".bottom-nav 존재 확인 실패", TestSupport.webElementExists(".bottom-nav"));
    }

    @Test
    public void managerModeBarExists() {
        assumeTrue(
            "TEST_MANAGER_A_EMAIL/PASSWORD가 설정되지 않아 건너뜀",
            TestSupport.TestAccount.hasManagerA()
        );
        TestSupport.waitForInitialLoad();
        TestSupport.loginWithEmail(TestSupport.TestAccount.managerAEmail(), TestSupport.TestAccount.managerAPassword());
        assertTrue("로그인 후 홈 화면 복귀 실패", TestSupport.webElementExists(".header .location"));

        TestSupport.clickNavTab("/mypage");
        try { Thread.sleep(2000); } catch (InterruptedException ignored) { Thread.currentThread().interrupt(); }
        onWebView()
            .withElement(findElement(Locator.CSS_SELECTOR, "a.manager-mode-switch"))
            .perform(webClick());
        try { Thread.sleep(2000); } catch (InterruptedException ignored) { Thread.currentThread().interrupt(); }

        assertTrue(".mgr-mode-bar 존재 확인 실패(관리자 홈)", TestSupport.webElementExists(".mgr-mode-bar"));
    }
}
