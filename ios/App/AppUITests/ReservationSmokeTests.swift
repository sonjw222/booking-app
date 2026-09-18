import XCTest

/*
  Automated Business Scenario E2E Batch(2026-09-18) — Phase 4: Layer B(iOS) 대표
  business scenario 매핑.

  전체 예약/취소/대기승격 로직(SCN-P0-03/04/20~25 등)은 이미 Shared(Layer A,
  tests/integration/scenarios/ 안의 *.test.ts 파일들)가 실제 RPC로 전부 원자성 있게 검증했다 — 이
  파일은 그걸 UI에서 "다시" 증명하지 않는다(요청 원칙: "모든 business scenario를
  플랫폼별로 재구현하지 않는다"). 대신 "회원이 실제로 예약 화면까지 도달해서 예약/대기
  액션 버튼을 볼 수 있는가"라는, Shared 레이어가 검증할 수 없는 딱 한 가지(실제 WebView
  렌더링 + 탭 네비게이션)만 스모크 수준으로 확인한다.

  ⚠ "예약" 하단 탭은 로그인 + 예약 가능한 수강권 보유 시에만 노출된다(NAV-001,
  TabNavigationTests.swift 주석과 동일 근거) — 공유 dev DB의 TEST_USER_A 수강권 보유
  상태는 다른 테스트 파일들의 fixture 상태에 따라 달라질 수 있으므로, 안 보이면
  실패시키지 않고 스킵한다(그 조건부 노출 자체는 이미 알려진 정상 동작).
*/
final class ReservationSmokeTests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testReservationScreenReachableAndRendersState() throws {
        guard TestAccount.hasUserA else {
            throw XCTSkip("TEST_USER_A_EMAIL/PASSWORD가 설정되지 않아 건너뜀 — docs/AUTOMATED_QA.md 참고")
        }
        let app = XCUIApplication()
        app.launchForUITesting()
        loginWithEmail(app, email: TestAccount.userAEmail!, password: TestAccount.userAPassword!)
        assertExists(app.webViews.staticTexts["오늘은 어떤 움직임을 찾나요?"], "로그인 후 홈 화면 복귀")

        let reserveTab = app.webViews.links["예약"]
        guard reserveTab.waitForExistence(timeout: 10) else {
            throw XCTSkip("'예약' 탭이 보이지 않음(NAV-001: 예약 가능한 수강권이 없으면 조건부로 숨겨짐 — 이 계정의 현재 수강권 보유 상태에 따라 달라질 수 있어 실패로 취급하지 않음)")
        }
        reserveTab.tap()
        app.waitForWebContent()

        // app/reservation/page.tsx — 실제 예약 가능한 수업이 있으면 각 행에 "예약"/"대기"
        // 버튼이, 마감이면 "마감" 표시가, 그 날 수업이 아예 없으면 "이 날은 예약 가능한
        // 수업이 없어요" 문구가 뜬다(소스 확인). 정확히 어느 상태인지는 테스트 데이터에
        // 의존하므로(SearchTests.swift와 동일 원칙) "화면이 멈추지 않고 이 중 하나에
        // 도달했는지"만 확인한다.
        let reserveButton = app.webViews.buttons["예약"]
        let waitButton = app.webViews.buttons["대기"]
        let emptyDay = app.webViews.staticTexts["이 날은 예약 가능한 수업이 없어요"]
        let reachedSomeState =
            reserveButton.waitForExistence(timeout: 15) ||
            waitButton.waitForExistence(timeout: 5) ||
            emptyDay.waitForExistence(timeout: 5)
        XCTAssertTrue(reachedSomeState, "예약 화면 진입 후 예약가능/대기/empty 상태 어느 쪽에도 도달하지 못함")
    }
}
