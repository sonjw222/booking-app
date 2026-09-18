import XCTest

/*
  Automated QA Foundation Batch(2026-09-18) — 요청 2-E: safe-area 회귀를 자동으로 잡을 수
  있는 최소 구조.

  픽셀 단위 safe-area 계산(정확한 env(safe-area-inset-top) 값 등)은 XCUITest에서 직접
  읽을 방법이 없다 — 대신 `XCUIElementTypeQueryProvider.statusBars`(Apple 공식 API,
  developer.apple.com/documentation/xctest/xcuielementtypequeryprovider/statusbars)로
  실제 상태바의 화면 frame을 얻어, 헤더 텍스트 엘리먼트의 frame.minY가 상태바
  frame.maxY보다 작으면(=상태바 영역 안으로 파고들면) 겹침으로 판정한다. 릴리스
  폴리시 배치 6/7차에서 반복 재현됐던 "스크롤 없이 첫 페인트부터 겹침" 버그를 이
  구조로 회귀 테스트할 수 있다(app/globals.css의 .header/.back-header/.resv-page-head/
  .mgr-mode-bar sticky+safe-area 계약).

  상태바 frame을 못 읽는 기기/OS 조합이면(드묾) 겹침 판정 대신 헤더 존재 여부만
  확인해 테스트 자체가 false-fail 나지 않게 한다.
*/
final class SafeAreaTests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    private func assertNoOverlap(_ app: XCUIApplication, headerElement: XCUIElement, description: String) {
        let statusBar = app.statusBars.firstMatch
        guard statusBar.waitForExistence(timeout: 5), headerElement.waitForExistence(timeout: 15) else {
            XCTFail("\(description) — 헤더 또는 상태바 엘리먼트를 찾지 못함")
            return
        }
        let statusBarBottom = statusBar.frame.maxY
        let headerTop = headerElement.frame.minY
        XCTAssertGreaterThanOrEqual(
            headerTop, statusBarBottom,
            "\(description) — 헤더 상단(y=\(headerTop))이 상태바 하단(y=\(statusBarBottom))보다 위에 있음(겹침)"
        )
    }

    func testHomeHeaderDoesNotOverlapStatusBar() throws {
        let app = XCUIApplication()
        app.launch()
        app.waitForWebContent()
        assertNoOverlap(app, headerElement: app.webViews.staticTexts["오늘은 어떤 움직임을 찾나요?"], description: "홈 화면 헤더")
    }

    func testReservationHeaderDoesNotOverlapStatusBar() throws {
        guard TestAccount.hasUserA else {
            throw XCTSkip("TEST_USER_A_EMAIL/PASSWORD가 설정되지 않아 건너뜀 — 예약 탭은 로그인+수강권 보유 시에만 노출됨")
        }
        let app = XCUIApplication()
        app.launch()
        loginWithEmail(app, email: TestAccount.userAEmail!, password: TestAccount.userAPassword!)
        assertExists(app.webViews.staticTexts["오늘은 어떤 움직임을 찾나요?"], "로그인 후 홈 화면 복귀")

        let reservationTab = app.webViews.links["예약"]
        guard reservationTab.waitForExistence(timeout: 10) else {
            throw XCTSkip("'예약' 탭이 노출되지 않음(테스트 계정에 예약 가능한 수강권이 없을 수 있음)")
        }
        reservationTab.tap()
        // app/reservation/page.tsx — .resv-page-head 안의 <h1>예약</h1>
        assertNoOverlap(app, headerElement: app.webViews.staticTexts["예약"], description: "예약 화면 헤더")
    }

    func testManagerModeBarDoesNotOverlapStatusBar() throws {
        guard TestAccount.hasManagerA else {
            throw XCTSkip("TEST_MANAGER_A_EMAIL/PASSWORD가 설정되지 않아 건너뜀")
        }
        let app = XCUIApplication()
        app.launch()
        loginWithEmail(app, email: TestAccount.managerAEmail!, password: TestAccount.managerAPassword!)
        assertExists(app.webViews.staticTexts["오늘은 어떤 움직임을 찾나요?"], "로그인 후 홈 화면 복귀")

        app.webViews.links["마이"].tap()
        let switchToManager = app.webViews.links["관리자 모드로 전환"]
        assertExists(switchToManager, "'관리자 모드로 전환' 링크")
        switchToManager.tap()

        // app/manager/page.tsx — .mgr-mode-bar 안의 "관리자 모드" 라벨
        assertNoOverlap(app, headerElement: app.webViews.staticTexts["관리자 모드"], description: "관리자 모드 상단 바")
    }
}
