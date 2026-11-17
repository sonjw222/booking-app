import Foundation
import Capacitor
import WebKit

/*
  iOS 전용 — 릴리스 폴리시 배치 8차(2026-09-17): WKWebView의
  allowsBackForwardNavigationGestures를 전역으로 항상 켜두면(SceneDelegate.swift,
  2026-09-15 QA 대응 — "스와이프가 전혀 안 된다") 문제는 해결되지만, 회원/관리자/운영자
  각 모드의 root 화면(홈/예약/내예약/알림/마이, 수업/회원/알림/더보기, 운영 홈)에서는
  반대로 edge swipe가 로그인 화면·이전 모드를 뒤에서 노출시킨다(QA 신고: "관리자 더보기 →
  edge swipe → 로그인 화면이 뒤에서 보임"). 화면 단위로 껐다 켰다 할 수 있는 최소 브릿지가
  필요해 이 작은 로컬 플러그인을 추가한다(WebViewThemePlugin.swift와 동일한 선례 — 신규
  npm 의존성 없음, capacitor.config.json packageClassList에 자동으로 안 실리므로
  SceneDelegate.swift에서 직접 registerPluginInstance() 필요).
  "지금이 root 화면인지" 판단은 JS(lib/navState.ts의 isRootNavPath)가 하고, 이 플러그인은
  그 결과만 받아 네이티브 프로퍼티를 토글한다 — 판정 로직 자체를 네이티브에 중복 구현하지
  않는다.
*/
@objc(NavigationPolicyPlugin)
public class NavigationPolicyPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NavigationPolicyPlugin"
    public let jsName = "NavigationPolicy"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "setEdgeSwipeEnabled", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setVerticalBounceEnabled", returnType: CAPPluginReturnPromise)
    ]

    @objc func setEdgeSwipeEnabled(_ call: CAPPluginCall) {
        let enabled = call.getBool("enabled") ?? true
        DispatchQueue.main.async { [weak self] in
            // 내장 양방향 제스처는 SceneDelegate 에서 영구히 꺼져 있다(오른쪽 "앞으로" 차단). 왼쪽 가장자리 back 인식기만 켜고 끈다.
            EdgeBackGesture.shared.setEnabled(enabled)
            call.resolve()
        }
    }

    /// 수강권 안내창(웹 lib/nativeBounce.ts)이 열려 있는 동안만 WebView 문서의 세로 바운스를 끄고(enabled=false), 닫히면 원래 값으로 복원(enabled=true).
    @objc func setVerticalBounceEnabled(_ call: CAPPluginCall) {
        let enabled = call.getBool("enabled") ?? true
        DispatchQueue.main.async {
            VerticalBounceController.shared.setEnabled(enabled)
            call.resolve()
        }
    }
}

/*
  수강권 안내창 전용 — WKWebView 문서의 세로 바운스(rubber-band)를 "시트가 열린 동안만" 끈다(2026-11-16, 실기기 QA: 시트를 끌 때 간헐적으로 문서 전체가 튕겨 흰 빈 영역이 생김).
  SceneDelegate 가 앱 전역으로 bounces=true / alwaysBounceVertical=true 를 켜 둔 것(당겨서 튕기는 느낌, 실기기 QA 항목)은 그대로 두고, 끄기 직전의 값을 저장했다가 복원한다.
  복원 조건: 웹이 enabled=true 를 호출 / 새 문서 로드 시작(WebView isLoading → 시트가 남은 채 화면이 전환되는 예외) / 앱이 비활성화(백그라운드) — 웹이 다시 보이면 필요 시 재적용한다.
  비공개 API 없음. 새 플러그인 없이 기존 NavigationPolicy 플러그인에 메서드만 추가했다.
*/
struct VerticalBounceState {
    private(set) var saved: (bounces: Bool, alwaysBounceVertical: Bool)?

    /// 끈다. 처음 끌 때만 현재 값을 저장한다(중복 호출이 이미 꺼진 값을 "원래 값"으로 덮어쓰지 않는다). 적용할 값(false, false)을 돌려준다.
    mutating func disable(currentBounces: Bool, currentAlwaysBounceVertical: Bool) -> (bounces: Bool, alwaysBounceVertical: Bool) {
        if saved == nil { saved = (currentBounces, currentAlwaysBounceVertical) }
        return (false, false)
    }

    /// 복원할 값(저장돼 있을 때만)을 돌려주고 저장을 비운다 — 끈 적이 없으면 nil(아무것도 바꾸지 않는다).
    mutating func restore() -> (bounces: Bool, alwaysBounceVertical: Bool)? {
        defer { saved = nil }
        return saved
    }
}

final class VerticalBounceController {
    static let shared = VerticalBounceController()
    private weak var webView: WKWebView?
    private var state = VerticalBounceState()
    private var loadingObservation: NSKeyValueObservation?
    private var resignObserver: NSObjectProtocol?

    func install(on webView: WKWebView) {
        guard self.webView == nil else { return }
        self.webView = webView
        loadingObservation = webView.observe(\.isLoading, options: [.new]) { [weak self] _, change in
            if change.newValue == true { DispatchQueue.main.async { self?.restore() } }   // 새 문서 로드 시작 — 시트가 열린 채 화면이 바뀌어도 바운스가 꺼진 채 남지 않게
        }
        resignObserver = NotificationCenter.default.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { [weak self] _ in self?.restore() }
    }

    func setEnabled(_ enabled: Bool) {
        if enabled { restore(); return }
        guard let scroll = webView?.scrollView else { return }
        let apply = state.disable(currentBounces: scroll.bounces, currentAlwaysBounceVertical: scroll.alwaysBounceVertical)
        scroll.bounces = apply.bounces
        scroll.alwaysBounceVertical = apply.alwaysBounceVertical
    }

    func restore() {
        guard let scroll = webView?.scrollView, let original = state.restore() else { return }
        scroll.bounces = original.bounces
        scroll.alwaysBounceVertical = original.alwaysBounceVertical
    }
}

/*
  NICEPAY 결제창 전용 안전 영역(Safe Area) 보정 — iOS 실기기 QA(TestFlight 1.0.3, 2026-11-09): 결제창 상단 헤더·X 닫기 버튼이 상태바/Dynamic Island 아래에 가려진다.

  원인: 이 앱은 capacitor.config.ts 의 ios.contentInset="never" + StatusBar.overlaysWebView=true 로 WKWebView 가 화면 전체(상태바 뒤)를 덮고, 안전 영역은 모하빗 페이지가
  env(safe-area-inset-*) 로 직접 처리한다(app/globals.css). NICEPAY 결제창은 외부 페이지라 그 처리가 없고 viewport-fit 도 없어서, 상단 고정 헤더가 y=0(상태바 뒤)에 그려진다.
  (시뮬레이터 하니스 실측: 수정 전 X 버튼 영역 y=6~50 < 안전 영역 상단 62 → 겹침.)

  수정: WebView 의 현재 주소(KVO)를 보고, NICEPAY 호스트에 있는 동안에만 scrollView.contentInsetAdjustmentBehavior 를 .always 로 바꿔 시스템이 상단/하단(홈 인디케이터)/가로 회전 시 좌우 안전 영역을
  WebView 콘텐츠에 적용하게 한다. 모하빗(앱 origin)으로 돌아오면 시작 시점의 값(.never)으로 복원한다. 그 밖의 호스트(소셜 로그인 등)에서는 아무것도 바꾸지 않는다.
  전역 StatusBar 설정·capacitor.config·모하빗 화면 CSS 는 건드리지 않고, NICEPAY 페이지의 DOM/폼/카드 입력 영역에는 접근하지 않는다. iOS 전용(Android 는 이 파일을 쓰지 않는다).
*/
enum NicepaySafeAreaPolicy {
    enum Action: Equatable { case applySystemInset, restoreAppDefault, keep }

    /// allowNavigation(capacitor.config.ts)에 넣은 NICEPAY 결제창 호스트와 같은 정확한 목록 — 와일드카드 없음.
    static let nicepayHosts: Set<String> = ["pg-web.nicepay.co.kr", "dc1-web.nicepay.co.kr", "web.nicepay.co.kr"]

    static func action(forHost host: String?, appHost: String?, hosts: Set<String> = nicepayHosts) -> Action {
        guard let h = host?.lowercased(), !h.isEmpty else { return .keep }
        if hosts.contains(h) { return .applySystemInset }
        if let a = appHost?.lowercased(), !a.isEmpty, h == a { return .restoreAppDefault }
        return .keep
    }
}

final class NicepaySafeAreaObserver: NSObject {
    private weak var webView: WKWebView?
    private let appHost: String?
    private let hosts: Set<String>
    private let appDefault: UIScrollView.ContentInsetAdjustmentBehavior
    private var observation: NSKeyValueObservation?

    init(webView: WKWebView, appHost: String?, hosts: Set<String> = NicepaySafeAreaPolicy.nicepayHosts) {
        self.webView = webView
        self.appHost = appHost
        self.hosts = hosts
        self.appDefault = webView.scrollView.contentInsetAdjustmentBehavior   // 앱의 기본값(.never) — Capacitor 가 config 로 이미 적용한 뒤의 값을 저장
        super.init()
        observation = webView.observe(\.url, options: [.initial, .new]) { [weak self] wv, _ in
            self?.apply(url: wv.url)
        }
    }

    private func apply(url: URL?) {
        guard let webView = webView else { return }
        let scroll = webView.scrollView
        switch NicepaySafeAreaPolicy.action(forHost: url?.host, appHost: appHost, hosts: hosts) {
        case .applySystemInset:
            if scroll.contentInsetAdjustmentBehavior != .always { scroll.contentInsetAdjustmentBehavior = .always }
        case .restoreAppDefault:
            if scroll.contentInsetAdjustmentBehavior != appDefault { scroll.contentInsetAdjustmentBehavior = appDefault }
        case .keep:
            break
        }
    }
}

/*
  앱 전체 "왼쪽 가장자리 뒤로가기만" 허용 (2026-11-09, UX 내비게이션 4번).
  WKWebView.allowsBackForwardNavigationGestures 는 왼쪽(뒤로)/오른쪽(앞으로)을 한 스위치로 켜서 방향 분리가 불가능하다.
  그래서 내장 제스처는 끄고(SceneDelegate), 공개 API UIScreenEdgePanGestureRecognizer(.left) 하나만 붙여 웹의 단일 back 정책
  (window.__mwhabitBack — 오버레이 먼저 닫기 / ‹ 버튼과 같은 도착 화면)을 호출한다. 비공개 API 없음.
  웹 정책이 없는 페이지(외부 호스트: NICEPAY 결제창, 로드 실패 화면)에서는 WebView 히스토리 뒤로가기로 폴백한다.
  가장자리 인식기는 화면 왼쪽 가장자리에서 시작한 터치만 가져가므로 가로 스크롤·캐러셀·캘린더·지도·시트 드래그·텍스트 선택에는 영향이 없다.
*/
enum EdgeBackPolicy {
    enum Action: Equatable { case none, webViewGoBack }

    /// JS 호출 결과(window.__mwhabitBack() 의 판정 문자열, 정책이 없으면 nil)를 받아 네이티브가 추가로 할 일을 정한다.
    static func action(bridgeResult: String?, canGoBack: Bool) -> Action {
        if bridgeResult != nil { return .none }   // 웹 정책이 이미 처리(오버레이 닫기/이동/root 무시)
        return canGoBack ? .webViewGoBack : .none
    }
}

final class EdgeBackGesture: NSObject, UIGestureRecognizerDelegate {
    static let shared = EdgeBackGesture()
    private(set) var recognizer: UIScreenEdgePanGestureRecognizer?
    private weak var webView: WKWebView?

    func install(on webView: WKWebView) {
        guard recognizer == nil else { return }
        self.webView = webView
        webView.allowsBackForwardNavigationGestures = false
        let r = UIScreenEdgePanGestureRecognizer(target: self, action: #selector(handle(_:)))
        r.edges = .left
        r.delegate = self
        webView.addGestureRecognizer(r)
        recognizer = r
    }

    func setEnabled(_ enabled: Bool) { recognizer?.isEnabled = enabled }

    @objc private func handle(_ g: UIScreenEdgePanGestureRecognizer) {
        guard g.state == .ended, let webView = webView else { return }
        // 충분히 오른쪽으로 끌었거나 빠르게 밀었을 때만 back 으로 인정(우발 터치 방지).
        let x = g.translation(in: webView).x
        let vx = g.velocity(in: webView).x
        guard x > 60 || vx > 500 else { return }
        webView.evaluateJavaScript("window.__mwhabitBack ? window.__mwhabitBack() : null") { [weak webView] result, _ in
            guard let webView = webView else { return }
            if EdgeBackPolicy.action(bridgeResult: result as? String, canGoBack: webView.canGoBack) == .webViewGoBack {
                webView.goBack()
            }
        }
    }

    func gestureRecognizer(_ g: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { true }
}
