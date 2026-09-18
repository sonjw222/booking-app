import XCTest

/*
  Automated QA Foundation Batch(2026-09-18) — 요청 2-C: 회원 ↔ 관리자 모드 전환.

  관리자 모드 진입은 active manager_centers 소속(=센터 운영자 계정)이 있어야만
  가능하다(ACL-005, app/mypage/page.tsx의 profile?.isManager 가드). 기존 테스트
  계정 중 TEST_MANAGER_A가 이 조건을 만족한다는 전제로, 이메일 로그인 후 확인한다
  (외부 OAuth는 사용 안 함 — 요청 4번 원칙). 테스트 계정 env가 없으면 스킵한다.
*/
final class ManagerModeTests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testSwitchToManagerModeAndBack() throws {
        guard TestAccount.hasManagerA else {
            throw XCTSkip("TEST_MANAGER_A_EMAIL/PASSWORD가 설정되지 않아 건너뜀 — docs/AUTOMATED_QA.md 참고")
        }
        let app = XCUIApplication()
        app.launch()
        loginWithEmail(app, email: TestAccount.managerAEmail!, password: TestAccount.managerAPassword!)

        // 로그인 성공 시 handleLogin()이 window.location.href = "/"로 이동 — 홈 화면이
        // 다시 뜨는 걸로 로그인 완료를 판단한다.
        assertExists(app.webViews.staticTexts["오늘은 어떤 움직임을 찾나요?"], "로그인 후 홈 화면 복귀")

        let myTab = app.webViews.links["마이"]
        assertExists(myTab, "하단 nav '마이' 탭")
        myTab.tap()

        // app/mypage/page.tsx — "관리자 모드로 전환"(manager-mode-switch)
        let switchToManager = app.webViews.links["관리자 모드로 전환"]
        assertExists(switchToManager, "'관리자 모드로 전환' 링크(관리자 권한 있는 계정에서만 노출)")
        switchToManager.tap()

        // app/manager/page.tsx — "관리자 모드" 라벨 + "회원 모드로 전환 ↩" 복귀 링크
        assertExists(app.webViews.staticTexts["관리자 모드"], "관리자 홈 상단 '관리자 모드' 라벨")
        let switchBack = app.webViews.links["회원 모드로 전환 ↩"]
        assertExists(switchBack, "'회원 모드로 전환' 복귀 링크")
        switchBack.tap()

        assertExists(app.webViews.staticTexts["오늘은 어떤 움직임을 찾나요?"], "회원 모드 복귀 후 홈 화면")
    }
}
