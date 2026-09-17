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
 * Automated Business Scenario E2E Batch(2026-09-18) — Phase 4: Layer C(Android) 대표
 * business scenario 매핑.
 *
 * ReservationSmokeTests.swift(iOS)와 동일한 설계 원칙 — 전체 예약/대기승격 로직은
 * Shared(Layer A)가 실제 RPC로 이미 검증했으므로, 여기서는 "회원이 실제로 예약 화면까지
 * 도달해서 액션 버튼을 볼 수 있는가"만 스모크로 확인한다.
 */
@RunWith(AndroidJUnit4.class)
public class ReservationSmokeTests {

    @Rule
    public ActivityScenarioRule<MainActivity> activityRule = new ActivityScenarioRule<>(MainActivity.class);

    @Test
    public void reservationScreenReachableAndRendersState() {
        assumeTrue(
            "TEST_USER_A_EMAIL/PASSWORD가 설정되지 않아 건너뜀 — docs/AUTOMATED_QA.md 참고",
            TestSupport.TestAccount.hasUserA()
        );
        TestSupport.waitForInitialLoad();
        TestSupport.loginWithEmail(TestSupport.TestAccount.userAEmail(), TestSupport.TestAccount.userAPassword());

        // NAV-001: "예약" 탭(a.nav-item[href='/reservation'])은 로그인 + 예약 가능한
        // 수강권 보유 시에만 노출된다 — 공유 dev DB의 계정 상태에 따라 달라질 수 있으므로
        // 없으면 실패가 아니라 건너뜀으로 처리한다(iOS ReservationSmokeTests.swift와 동일
        // 근거).
        assumeTrue(
            "'예약' 탭(a.nav-item[href='/reservation'])이 보이지 않음(NAV-001 조건부 노출)",
            TestSupport.webElementExists("a.nav-item[href='/reservation']")
        );
        onWebView()
            .withElement(findElement(Locator.CSS_SELECTOR, "a.nav-item[href='/reservation']"))
            .perform(webClick());
        try { Thread.sleep(3000); } catch (InterruptedException ignored) { Thread.currentThread().interrupt(); }

        // app/reservation/page.tsx — .mini-btn(예약/대기 액션 버튼) 또는 .daylist-empty
        // (그 날 예약 가능한 수업이 없을 때, 소스 확인 — SearchTests.java가 쓰는
        // .app-empty-state와는 다른 별개의 empty state 클래스임에 주의) 중 하나에
        // 도달하는지만 확인(정확한 결과는 테스트 데이터 의존적이라 검증 대상이 아님).
        boolean reachedSomeState =
            TestSupport.webElementExists(".mini-btn") || TestSupport.webElementExists(".daylist-empty");
        assertTrue("예약 화면 진입 후 액션버튼/empty 상태 어느 쪽에도 도달하지 못함", reachedSomeState);
    }
}
