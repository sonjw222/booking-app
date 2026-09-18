import XCTest

/*
  Automated QA Foundation Batch(2026-09-18) — 요청 2-B/2-C: 하단 탭 전환 + 회원/관리자
  모드 전환.

  app/components/BottomNav.tsx는 <Link>(=<a> 태그)로 렌더링되므로 app.webViews.links로
  찾는다. "예약"/"내 예약" 탭은 로그인 + 예약 가능한 수강권 보유 시에만 노출되므로
  (NAV-001, lib/navState.ts) 비로그인/테스트 계정 부재 시에는 확인하지 않는다 —
  존재를 가정하고 실패시키지 않는다.
*/
final class TabNavigationTests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testMemberTabsAlwaysPresent() throws {
        let app = XCUIApplication()
        app.launch()
        app.waitForWebContent()

        for label in ["홈", "알림", "마이"] {
            assertExists(app.webViews.links[label], "하단 nav '\(label)' 탭(로그인 여부 무관 항상 노출)")
        }
    }

    func testHomeToMyPageTabSwitch() throws {
        let app = XCUIApplication()
        app.launch()
        app.waitForWebContent()

        let myTab = app.webViews.links["마이"]
        assertExists(myTab, "하단 nav '마이' 탭")
        myTab.tap()

        // app/mypage/page.tsx — 비로그인이면 로그인 유도 화면, 로그인 상태면 프로필
        // 블록이 뜬다. 둘 중 하나만 확인해도 "탭 전환 자체가 됐는지"는 검증됨 — 로그인
        // 여부는 이 테스트의 관심사가 아니다. 로그인 화면으로 가면 "로그인하러 가기"
        // 버튼이, 마이페이지면 "내 정보 관리" 링크가 뜬다(app/mypage/page.tsx,
        // app/mypage/info 진입점).
        let loggedOutCta = app.webViews.links["로그인하러 가기"]
        let loggedInAnchor = app.webViews.links["내 정보 관리"]
        let appeared = loggedOutCta.waitForExistence(timeout: 15) || loggedInAnchor.waitForExistence(timeout: 5)
        XCTAssertTrue(appeared, "'마이' 탭 전환 후 마이페이지 관련 화면이 뜨지 않음")
    }
}
