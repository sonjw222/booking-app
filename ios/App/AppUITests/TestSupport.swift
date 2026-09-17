import XCTest

/*
  Automated QA Foundation Batch(2026-09-18) — 공용 헬퍼.

  이 앱은 Capacitor server.url 모드라 WKWebView가 실제 배포된 웹사이트를 그대로
  띄운다(로컬 번들 아님) — XCUITest가 보는 "화면"은 전부 WKWebView 안의 웹 콘텐츠다.
  Apple 공식 제약: WKWebView 안의 DOM 엘리먼트는 accessibilityIdentifier로 찾을 수
  없고, label/value/placeholder(=텍스트, aria-label, placeholder)로만 찾을 수 있다
  (WebKit이 접근성 트리로 노출하는 정보가 그것뿐 — 여러 공식/비공식 자료로 확인함,
  docs/AUTOMATED_QA.md 참고). 이 앱은 현재 한국어 단일 언어라(다국어 전환 로드맵
  없음, 코드에서 확인) 한국어 텍스트 기준 조회가 실제로는 안정적이다.

  이 파일은 텍스트 기반 조회를 반복하지 않도록 감싼 최소 헬퍼만 담는다 — 새 테스트
  프레임워크를 만들지 않음(요청 범위 밖).
*/
enum TestAccount {
    static let userAEmail = ProcessInfo.processInfo.environment["TEST_USER_A_EMAIL"]
    static let userAPassword = ProcessInfo.processInfo.environment["TEST_USER_A_PASSWORD"]
    static let managerAEmail = ProcessInfo.processInfo.environment["TEST_MANAGER_A_EMAIL"]
    static let managerAPassword = ProcessInfo.processInfo.environment["TEST_MANAGER_A_PASSWORD"]

    // tests/e2e(Playwright)와 완전히 동일한 이름의 기존 테스트 전용 계정을 재사용한다
    // (새 계정을 만들지 않음, docs/AUTOMATED_QA.md 참고). 값이 없으면(로컬에서 export
    // 안 했거나 CI secret 미설정) 로그인이 필요한 테스트는 XCTSkip으로 건너뛴다 —
    // 실패 처리하지 않는다(요청 8번 "secrets 없으면 graceful skip").
    static var hasUserA: Bool { userAEmail != nil && userAPassword != nil }
    static var hasManagerA: Bool { managerAEmail != nil && managerAPassword != nil }
}

extension XCUIApplication {
    // WKWebView 콘텐츠가 실제로 그려질 때까지 기다린다 — server.url 모드라 최초 로드는
    // 실제 네트워크 왕복을 거친다(로컬 번들이 아님), 시뮬레이터/CI 네트워크가 느릴 수
    // 있어 넉넉한 타임아웃을 쓴다.
    func waitForWebContent(timeout: TimeInterval = 20) {
        let webView = webViews.firstMatch
        _ = webView.waitForExistence(timeout: timeout)
    }
}

extension XCTestCase {
    // 텍스트/식별자 기반 존재 확인을 반복하지 않도록 감싼 헬퍼 — 실패 시 어떤 쿼리를
    // 기다렸는지 메시지에 남겨서, 텍스트 문구가 나중에 바뀌었을 때 원인을 바로 알 수
    // 있게 한다(docs/AUTOMATED_QA.md의 "자주 생기는 오류" 참고).
    func assertExists(_ element: XCUIElement, timeout: TimeInterval = 15, _ description: String, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(
            element.waitForExistence(timeout: timeout),
            "\(description) — 화면에서 찾지 못함(텍스트/문구가 바뀌었을 수 있음, docs/AUTOMATED_QA.md 참고)",
            file: file,
            line: line
        )
    }

    // 로그인 폼(app/login/page.tsx)에 이메일/비밀번호를 입력하고 제출한다. Kakao/Naver/
    // Google/Apple 같은 외부 OAuth는 절대 자동화하지 않는다(요청 4번 원칙) — 이메일
    // 로그인만, 그것도 기존 테스트 계정으로만 수행한다.
    func loginWithEmail(_ app: XCUIApplication, email: String, password: String) {
        app.waitForWebContent()
        let emailField = app.webViews.textFields.firstMatch
        assertExists(emailField, "로그인 화면 이메일 입력창")
        emailField.tap()
        emailField.typeText(email)

        let passwordField = app.webViews.secureTextFields.firstMatch
        assertExists(passwordField, "로그인 화면 비밀번호 입력창")
        passwordField.tap()
        passwordField.typeText(password)

        // 주의: "로그인" 텍스트가 상단 모드 탭(로그인/회원가입 전환)에도 있어 label
        // 기준 조회가 두 엘리먼트에 걸린다(Playwright E2E도 동일한 이유로
        // button.login-submit CSS 클래스를 따로 씀 — tests/e2e/auth.setup.ts 참고,
        // XCUITest는 WKWebView 안에서 CSS 클래스로 못 찾음, label만 가능). DOM
        // 순서상 모드 탭이 먼저(index 0), 실제 제출 버튼이 나중(마지막 index)에
        // 렌더링되므로 마지막 매치를 쓴다 — 실기기 검증 전까지는 최선 추정치임을
        // docs/AUTOMATED_QA.md에 명시.
        let loginButtons = app.webViews.buttons.matching(NSPredicate(format: "label == %@", "로그인"))
        XCTAssertGreaterThan(loginButtons.count, 0, "로그인 버튼을 하나도 못 찾음")
        let submit = loginButtons.element(boundBy: loginButtons.count - 1)
        submit.tap()
    }
}
