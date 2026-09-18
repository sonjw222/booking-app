import XCTest

/*
  Automated QA Foundation Batch(2026-09-18) — 요청 2-D: 검색 화면 진입 + 입력 + 결과/empty
  상태 확인.
*/
final class SearchTests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testSearchInputAndSuggestions() throws {
        let app = XCUIApplication()
        app.launchForUITesting()
        app.waitForWebContent()

        // 홈 화면 검색바(app/page.tsx의 .searchbar)를 거쳐 /search로 진입한다 — 직접
        // 딥링크 대신 실제 사용자 동선을 그대로 따라간다.
        let homeSearchEntry = app.webViews.links["클래스, 센터를 검색해보세요"]
        assertExists(homeSearchEntry, "홈 화면 검색 진입 링크")
        homeSearchEntry.tap()

        // app/search/page.tsx — placeholder로 입력창을 찾는다(autoFocus라 이미 포커스돼
        // 있을 수 있음, 명시적으로 한 번 더 tap해도 안전).
        let searchInput = app.webViews.textFields["센터 이름 또는 종목 검색"]
        assertExists(searchInput, "검색 입력창")
        searchInput.tap()
        searchInput.typeText("필라테스")

        let searchButton = app.webViews.buttons["검색"]
        assertExists(searchButton, "검색 실행 버튼")
        searchButton.tap()

        // 검색 결과가 있으면 "센터 (N)" 섹션 라벨이, 없으면 EmptyState("검색 결과가
        // 없어요", app/components/EmptyState.tsx)가 뜬다 — app/search/page.tsx 소스로
        // 정확한 문구를 확인함. 정확한 결과 개수는 테스트 데이터에 의존하므로
        // 검증하지 않고, "화면이 멈추지 않고 둘 중 하나의 상태에 도달했는지"만
        // 확인한다. "센터"는 개수 접미사(" (N)")가 붙어 정확히 일치하지 않을 수 있어
        // CONTAINS로 찾는다.
        let resultsHeading = app.webViews.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "센터")).firstMatch
        let emptyState = app.webViews.staticTexts["검색 결과가 없어요"]
        let reachedSomeState = resultsHeading.waitForExistence(timeout: 15) || emptyState.waitForExistence(timeout: 5)
        XCTAssertTrue(reachedSomeState, "검색 실행 후 결과/empty 상태 어느 쪽에도 도달하지 못함")
    }
}
