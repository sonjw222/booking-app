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
        CAPPluginMethod(name: "setEdgeSwipeEnabled", returnType: CAPPluginReturnPromise)
    ]

    @objc func setEdgeSwipeEnabled(_ call: CAPPluginCall) {
        let enabled = call.getBool("enabled") ?? true
        DispatchQueue.main.async { [weak self] in
            self?.bridge?.webView?.allowsBackForwardNavigationGestures = enabled
            call.resolve()
        }
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
