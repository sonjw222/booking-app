import XCTest

/*
  Automated QA Foundation Batch(2026-09-18) — 요청 2-A: 앱 실행 + 첫 화면 표시 확인.
*/
final class LaunchTests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testAppLaunchesAndShowsHome() throws {
        let app = XCUIApplication()
        app.launch()
        app.waitForWebContent()

        // 비로그인 상태의 홈 화면 고정 문구 — app/page.tsx. 로그인 상태여도 이 헤더
        // 텍스트 자체는 항상 뜬다(로그인 여부와 무관한 화면 제목).
        assertExists(app.webViews.staticTexts["오늘은 어떤 움직임을 찾나요?"], "홈 화면 헤더 문구")

        // 하단 nav가 최소 3개 탭(홈/알림/마이 — 예약/내예약은 로그인+수강권 보유 시에만
        // 노출, app/components/BottomNav.tsx)은 항상 뜬다. 탭은 Next.js <Link>가 렌더링한
        // <a> 태그라 버튼이 아니라 링크로 노출된다(app.webViews.links, buttons 아님).
        assertExists(app.webViews.links["홈"], "하단 nav 홈 탭")
    }

    // 요청 2-F: background/foreground 후 화면 유지 확인.
    func testForegroundAfterBackground() throws {
        let app = XCUIApplication()
        app.launch()
        app.waitForWebContent()
        assertExists(app.webViews.staticTexts["오늘은 어떤 움직임을 찾나요?"], "백그라운드 진입 전 홈 화면")

        XCUIDevice.shared.press(.home)
        // 시뮬레이터/실기기 모두 홈 버튼 후 앱이 백그라운드로 완전히 전환될 시간을 준다.
        Thread.sleep(forTimeInterval: 2)
        app.activate()

        assertExists(app.webViews.staticTexts["오늘은 어떤 움직임을 찾나요?"], "포그라운드 복귀 후 홈 화면 유지")
    }
}
