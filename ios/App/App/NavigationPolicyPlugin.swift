import Foundation
import Capacitor

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
