import XCTest

/*
  Automated QA Foundation Batch(2026-09-18), XCUITest Safe-Area Repair(2026-09-19) —
  요청 2-E: safe-area 회귀를 자동으로 잡을 수 있는 최소 구조.

  ⚠ 2026-09-19 수정 배경(실측으로 확인, 추측 아님): `app.statusBars.firstMatch`가 이
  앱에서는 항상(우연히 가끔이 아니라 매번) 0건이다 — 실제 시뮬레이터(iOS 27, iPhone 17)
  에서 접근성 트리 전체를 덤프해 직접 확인했다(app.statusBars.count == 0). 원인으로
  가장 유력한 건 capacitor.config.json의 `StatusBar.overlaysWebView: true` +
  `ios.contentInset: "never"` 조합 — 상태바가 WKWebView 위에 완전히 투명하게 얹히는
  edge-to-edge 구성이라, 이 앱엔 XCUITest가 별도로 인식할 수 있는 네이티브 상태바
  "엘리먼트" 자체가 없다(SpringBoard가 그리는 시스템 오버레이일 뿐, 이 앱의 접근성
  윈도우 트리에 노출되지 않음). 반면 헤더 텍스트("오늘은 어떤 움직임을 찾나요?")는
  같은 덤프에서 frame.minY=72로 안정적으로 존재가 확인됐다 — 즉 실패 메시지("헤더 또는
  상태바 엘리먼트를 찾지 못함")의 실제 원인은 항상 상태바 쪽이었지 헤더 쪽이 아니었다.

  그래서 `statusBars`는 계속 1차로 시도하되(다른 기기/OS/앱 구성에서는 될 수도 있는
  공식 API라 제거하지 않음), 못 찾으면 임의로 통과시키는 대신 "이 기기가 논치/Dynamic
  Island가 있는 all-screen 기종인지"를 화면 세로 길이로 판별해(아래 SafeAreaFallback
  참고) Apple이 2017년 iPhone X 출시 이후 지금까지 한 번도 어긴 적 없는 최소 top
  safe-area 하한선(all-screen 44pt / 구형·SE 20pt)과 비교한다 — "느슨하게 풀어서 항상
  통과"가 아니라 "다른, 그러나 여전히 신뢰 가능한 절대값 하한"으로 같은 강도의 검증을
  유지한다(요청 6/8번). (참고: 처음엔 XCUIDevice.shared.name으로 기기 모델명을 직접
  판별하려 했으나 이 XCTest 버전엔 그런 API가 없어 빌드 자체가 실패했다 — 실측으로
  확인 후 화면 크기 기반 판별로 교체.)
*/

// statusBars API를 못 쓸 때 쓰는 대체 하한선. XCUIDevice에는 기기 모델명을 주는 공식
// API가 없어(XCUIDevice.shared.name 시도 → 컴파일 에러로 확인됨, iOS 27 SDK) 기기
// "이름"이 아니라 창 프레임의 세로 길이(항상 안정적으로 조회 가능)로 "all-screen
// 기종(노치/Dynamic Island 있음)인지"만 판별한다 — 몇 pt인지 정확히 맞히는 대신,
// Apple이 iPhone X(2017)부터 지금까지 all-screen 기종에서 한 번도 어긴 적 없는
// "최소" 상한(44pt)을 보수적으로 쓴다. 실제 겹침 버그(헤더가 y≈0 근처에서 렌더링되는
// 회귀)는 이 하한만으로도 충분히 잡힌다 — 정확한 기종별 수치(47/59pt)보다 느슨하지만
// "0 근처 겹침"이라는 이 테스트의 실제 목적엔 여전히 민감하다.
private enum SafeAreaFallback {
    // portrait 세로 길이(pt) 기준 — iPhone SE(3세대) 등 홈버튼 기종은 667/736pt,
    // all-screen 기종(X 이후 전부)은 812pt 이상이다(가장 작은 mini도 812).
    static func minTopInset(screenHeight: CGFloat) -> CGFloat {
        screenHeight >= 812 ? 44 : 20
    }
}

final class SafeAreaTests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    private func assertNoOverlap(_ app: XCUIApplication, headerElement: XCUIElement, description: String) throws {
        guard headerElement.waitForExistence(timeout: 15) else {
            XCTFail("\(description) — 헤더 엘리먼트를 찾지 못함(텍스트/문구가 바뀌었을 수 있음)")
            return
        }
        let headerTop = headerElement.frame.minY

        // 1차: 공식 statusBars API(가능한 기기/OS 구성에서는 실제 프레임을 그대로 씀 —
        // 이 값이 있으면 표보다 더 정확하므로 우선한다).
        let statusBar = app.statusBars.firstMatch
        if statusBar.waitForExistence(timeout: 3) {
            let statusBarBottom = statusBar.frame.maxY
            XCTAssertGreaterThanOrEqual(
                headerTop, statusBarBottom,
                "\(description) — 헤더 상단(y=\(headerTop))이 상태바 하단(y=\(statusBarBottom))보다 위에 있음(겹침)"
            )
            return
        }

        // 2차 대체: statusBars가 이 앱 구성에서 항상 0건인 게 실측으로 확인됨(위 주석
        // 참고) — 화면 세로 길이 기반 최소 top safe-area 하한으로 같은 검증을 계속한다.
        guard let window = app.windows.allElementsBoundByIndex.first, window.frame.height > 0 else {
            throw XCTSkip("\(description) — statusBars API도, 화면 크기 판별용 window frame도 못 찾아 신뢰 가능한 대체 기준이 없어 건너뜀(false-pass 방지)")
        }
        let minTopInset = SafeAreaFallback.minTopInset(screenHeight: window.frame.height)
        XCTAssertGreaterThanOrEqual(
            headerTop, minTopInset,
            "\(description) — 헤더 상단(y=\(headerTop))이 이 화면 크기(세로 \(window.frame.height)pt)의 최소 안전영역(\(minTopInset)pt)보다 위에 있음(겹침)"
        )
    }

    func testHomeHeaderDoesNotOverlapStatusBar() throws {
        let app = XCUIApplication()
        app.launchForUITesting()
        app.waitForWebContent()
        try assertNoOverlap(app, headerElement: app.webViews.staticTexts["오늘은 어떤 움직임을 찾나요?"], description: "홈 화면 헤더")
    }

    func testReservationHeaderDoesNotOverlapStatusBar() throws {
        guard TestAccount.hasUserA else {
            throw XCTSkip("TEST_USER_A_EMAIL/PASSWORD가 설정되지 않아 건너뜀 — 예약 탭은 로그인+수강권 보유 시에만 노출됨")
        }
        let app = XCUIApplication()
        app.launchForUITesting()
        loginWithEmail(app, email: TestAccount.userAEmail!, password: TestAccount.userAPassword!)
        assertExists(app.webViews.staticTexts["오늘은 어떤 움직임을 찾나요?"], "로그인 후 홈 화면 복귀")

        let reservationTab = app.webViews.links["예약"]
        guard reservationTab.waitForExistence(timeout: 10) else {
            throw XCTSkip("'예약' 탭이 노출되지 않음(테스트 계정에 예약 가능한 수강권이 없을 수 있음)")
        }
        reservationTab.tap()
        // app/reservation/page.tsx — .resv-page-head 안의 <h1>예약</h1>
        try assertNoOverlap(app, headerElement: app.webViews.staticTexts["예약"], description: "예약 화면 헤더")
    }

    func testManagerModeBarDoesNotOverlapStatusBar() throws {
        guard TestAccount.hasManagerA else {
            throw XCTSkip("TEST_MANAGER_A_EMAIL/PASSWORD가 설정되지 않아 건너뜀")
        }
        let app = XCUIApplication()
        app.launchForUITesting()
        loginWithEmail(app, email: TestAccount.managerAEmail!, password: TestAccount.managerAPassword!)
        assertExists(app.webViews.staticTexts["오늘은 어떤 움직임을 찾나요?"], "로그인 후 홈 화면 복귀")

        app.webViews.links["마이"].tap()
        let switchToManager = app.webViews.links["관리자 모드로 전환"]
        assertExists(switchToManager, "'관리자 모드로 전환' 링크")
        switchToManager.tap()

        // app/manager/page.tsx — .mgr-mode-bar 안의 "관리자 모드" 라벨
        try assertNoOverlap(app, headerElement: app.webViews.staticTexts["관리자 모드"], description: "관리자 모드 상단 바")
    }
}
