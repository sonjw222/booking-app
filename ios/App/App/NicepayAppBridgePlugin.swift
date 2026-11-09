import UIKit
import WebKit
import Capacitor

/*
  NICEPAY v3 앱(WebView) 결제 — 카드사/ISP 앱 호출과 모하빗 앱 복귀(iOS). 순수 판정은 NicepayAppReturn.swift, 이 파일은 UIKit/Capacitor 연결만 한다.
  Capacitor 기본 동작(WebViewDelegationHandler): 허용(allowNavigation)되지 않은 최상위 이동은 모두 UIApplication.open 으로 바깥에 넘긴다 — 카드사 scheme 이 열리지 않아도(미설치) 아무 안내가 없고,
  결제 화면에서 임의 scheme 이 그대로 열린다. 이 플러그인은 Capacitor 의 shouldOverrideLoad 훅으로 "결제 문맥"에서만 이를 다듬는다:
    · 카드사 앱 scheme(허용 목록, 공식 문서 기준) → 앱을 열고, 열 수 없으면(미설치) 안내(ISP 는 App Store). 결제를 성공/실패로 판단하지 않는다.
    · 결제 문맥(NICEPAY 호스트·/checkout 화면)에서 허용 목록 밖 custom scheme → 차단(임의 앱 실행 방지).
    · 그 밖의 이동(로그인 포함)은 nil 을 돌려 Capacitor 기존 동작을 그대로 쓴다.
  복귀: 카드사 앱 인증 후 WapUrl(`<scheme>://nicepay/wap?orderId=…`) / ISP 취소 IspCancelUrl(`…/cancel?…`) 로 앱이 열리면 SceneDelegate 가 handleReturn 을 부른다.
    · 검증을 통과한 URL 만 처리하고, 열 화면은 우리 서버(Capacitor server.url)의 결제 결과 화면뿐이다. 복귀 URL 에는 비밀이 없고 "복귀 = 결제 성공"이 아니다(결과 화면이 서버에 상태를 묻는다).
    · 진행 중 인증 흐름(wap, WebView 가 NICEPAY/결제 화면)에서는 화면을 바꾸지 않는다. 앱이 재시작된 경우(콜드 스타트)에는 결과 화면으로 간다.
    · 같은 URL 이 3초 안에 다시 오면 무시(중복 복귀).
  GoogleSignIn/Capacitor URL 처리와 충돌하지 않는다: SceneDelegate 는 Google 이 처리하지 않은 URL 중 우리 scheme 만 여기로 보내고, 나머지는 기존대로 Capacitor 로 넘긴다.
*/
@objc(NicepayAppBridgePlugin)
public class NicepayAppBridgePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NicepayAppBridgePlugin"
    public let jsName = "NicepayAppBridge"
    public let pluginMethods: [CAPPluginMethod] = []

    private static var lastHandled: (url: String, at: Date)?

    // MARK: 카드사 앱 호출 / 결제 문맥 scheme 차단
    @objc public override func shouldOverrideLoad(_ navigationAction: WKNavigationAction) -> NSNumber? {
        guard let url = navigationAction.request.url else { return nil }
        let appHost = bridge?.config.serverURL.host
        let ctx = NicepayAppReturn.isPaymentContext(currentURL: bridge?.webView?.url, appHost: appHost)
        switch NicepayAppReturn.decide(urlScheme: url.scheme, paymentContext: ctx) {
        case .notApplicable: return nil
        case .blocked: return NSNumber(value: true)   // 취소(WebView 에서 이동하지 않음, 앱도 열지 않음)
        case .openCardApp:
            openCardApp(url)
            return NSNumber(value: true)
        }
    }

    private func openCardApp(_ url: URL) {
        DispatchQueue.main.async { [weak self] in
            UIApplication.shared.open(url, options: [:]) { opened in
                if opened { return }
                DispatchQueue.main.async { self?.handleNotInstalled(url) }
            }
        }
    }

    private func handleNotInstalled(_ url: URL) {
        if url.scheme?.lowercased() == "ispmobile", let store = URL(string: "itms-apps://itunes.apple.com/app/id\(NicepayAppReturn.ispAppStoreId)") {
            UIApplication.shared.open(store, options: [:], completionHandler: nil)   // 샘플 문서: ISP 미설치 → App Store
            return
        }
        let alert = UIAlertController(title: "카드사 앱을 열 수 없어요", message: "카드사 앱이 설치되어 있지 않거나 열 수 없어요. 앱을 설치한 뒤 다시 결제하거나 다른 결제 수단을 이용해주세요. 결제는 완료되지 않았어요.", preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "확인", style: .default))
        bridge?.viewController?.present(alert, animated: true)
    }

    // MARK: 앱 복귀
    /// 우리 복귀 scheme 이면 true(처리했거나 무시했거나 — Capacitor 로 넘기지 않는다). 아니면 false.
    @discardableResult
    static func handleReturn(_ url: URL, bridge: CAPBridgeProtocol?, coldStart: Bool = false) -> Bool {
        guard url.scheme?.lowercased() == NicepayAppReturn.scheme else { return false }
        let raw = url.absoluteString
        guard let parsed = NicepayAppReturn.parse(raw) else { return true }   // 형식 위반(위조 포함): 아무것도 하지 않는다
        if let last = lastHandled, last.url == raw, Date().timeIntervalSince(last.at) < 3 { return true }   // 중복 복귀
        lastHandled = (raw, Date())
        guard let bridge = bridge, let webView = bridge.webView else { return true }
        let go = {
            let appHost = bridge.config.serverURL.host
            let current = coldStart ? nil : webView.url
            guard NicepayAppReturn.shouldNavigate(kind: parsed.kind, currentURL: current, appHost: appHost) else { return }
            guard let target = URL(string: bridge.config.serverURL.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + NicepayAppReturn.resultPath(parsed)) else { return }
            webView.load(URLRequest(url: target))
        }
        // 콜드 스타트: Capacitor 의 첫 로드가 끝난 뒤에 열어야 덮어써지지 않는다.
        if coldStart { DispatchQueue.main.asyncAfter(deadline: .now() + 1.0, execute: go) } else { DispatchQueue.main.async(execute: go) }
        return true
    }
}
