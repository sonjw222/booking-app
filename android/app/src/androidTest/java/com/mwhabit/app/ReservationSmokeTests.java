package com.mwhabit.app;

import static org.junit.Assert.assertTrue;
import static org.junit.Assume.assumeTrue;

import android.Manifest;
import androidx.test.ext.junit.rules.ActivityScenarioRule;
import androidx.test.rule.GrantPermissionRule;
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
    public void reservationScreenReachableAndRendersState() {
        assumeTrue(
            "TEST_USER_A_EMAIL/PASSWORD가 설정되지 않아 건너뜀 — docs/AUTOMATED_QA.md 참고",
            TestSupport.TestAccount.hasUserA()
        );
        TestSupport.waitForInitialLoad();
        TestSupport.loginWithEmail(TestSupport.TestAccount.userAEmail(), TestSupport.TestAccount.userAPassword());

        // NAV-001: "예약" 탭은 로그인 + 예약 가능한 수강권 보유 시에만 렌더링된다(mobile
        // bottom-nav/tablet rail 둘 다 같은 조건으로 렌더링 — app/components/BottomNav.tsx)
        // — 공유 dev DB의 계정 상태에 따라 달라질 수 있으므로 없으면 실패가 아니라
        // 건너뜀으로 처리한다(iOS ReservationSmokeTests.swift와 동일 근거).
        // navTabAvailable()은 mobile/tablet-rail 두 selector 중 하나라도 DOM에 있는지로
        // 판별한다(breakpoint에 따라 어느 쪽이 실제로 "보이는지"는 클릭 시점에
        // clickNavTab()이 따로 처리 — 여기서는 "탭 자체가 조건부로 존재하는지"만 확인).
        assumeTrue(
            "'예약' 탭이 보이지 않음(NAV-001 조건부 노출)",
            TestSupport.navTabAvailable("/reservation")
        );
        TestSupport.clickNavTab("/reservation");

        // app/reservation/page.tsx — .mini-btn(예약/대기 액션 버튼) 또는 .daylist-empty
        // (그 날 예약 가능한 수업이 없을 때, 소스 확인 — SearchTests.java가 쓰는
        // .app-empty-state와는 다른 별개의 empty state 클래스임에 주의) 중 하나에
        // 도달하는지만 확인(정확한 결과는 테스트 데이터 의존적이라 검증 대상이 아님).
        // 고정 sleep 대신 폴링(요청 11번, SearchTests와 동일 근거).
        boolean reachedSomeState = TestSupport.waitForAnyElement(8000, ".mini-btn", ".daylist-empty");
        assertTrue("예약 화면 진입 후 액션버튼/empty 상태 어느 쪽에도 도달하지 못함", reachedSomeState);
    }
}
