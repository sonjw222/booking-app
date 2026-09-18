import Foundation
import UIKit
import Capacitor

/*
  iOS 전용 — WKWebView의 오버스크롤(rubber-band) 배경색을 앱의 현재 라이트/다크 테마에
  맞춰 런타임에 바꾼다.

  릴리스 폴리시 배치(2026-09-14, 2차) — capacitor.config.ts의 정적 backgroundColor 하나만
  으로는 라이트 테마 기준 색(#FBFBFA)으로 고정돼, 사용자가 다크(차콜) 테마를 쓰면 오버스크롤
  구간에서 여전히 어긋나 보였다("navy strip"과 같은 종류의 문제 — 실기기 진단
  2026-09-11/2026-09-14 참고). 두 단계로 해결:
  1. SceneDelegate.swift가 앱 기동 시 iOS 시스템 라이트/다크 설정을 자동으로 따라가는
     동적 UIColor(dynamicProvider:)를 baseline으로 설정 — "시스템 설정 따르기"가 기본값인
     사용자는 이것만으로 이미 맞다.
  2. 이 앱은 시스템 설정과 별개로 앱 안에서 라이트/다크를 직접 고를 수도 있어(설정 화면),
     그 명시적 선택까지 반영하려면 JS가 "지금 실제로 적용된 테마가 뭔지" 알려줘야 한다 —
     이 플러그인이 그 마지막 다리 역할(작은 로컬 커스텀 플러그인, FcmTokenPlugin.swift와
     동일한 선례 — 신규 npm 의존성 없음). app/layout.tsx의 하이드레이션 전 인라인 테마
     스크립트(콜드 스타트 커버)와 app/settings/theme/page.tsx의 applyTheme()(런타임 전환
     커버) 양쪽에서 호출한다.
*/
@objc(WebViewThemePlugin)
public class WebViewThemePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "WebViewThemePlugin"
    public let jsName = "WebViewTheme"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "setBackground", returnType: CAPPluginReturnPromise)
    ]

    @objc func setBackground(_ call: CAPPluginCall) {
        guard let hex = call.getString("hex"), let color = UIColor(mwhabitHex: hex) else {
            call.reject("유효한 hex 색상(#RRGGBB)이 필요해요")
            return
        }
        DispatchQueue.main.async { [weak self] in
            guard let webView = self?.bridge?.webView else {
                call.resolve()
                return
            }
            webView.backgroundColor = color
            webView.scrollView.backgroundColor = color
            if #available(iOS 15.0, *) {
                // 오버스크롤(elastic scrolling) 중 실제 페이지 콘텐츠 밖에 보이는 색을
                // 위한 공식 API(Apple 문서) — scrollView.backgroundColor와 함께 둘 다
                // 맞춰준다(Capacitor 자체가 scrollView.backgroundColor 쪽만 쓰므로 그게
                // 실기기에서 확인된 핵심 레이어이지만, 최신 API도 같이 맞추는 게 안전).
                webView.underPageBackgroundColor = color
            }
            call.resolve()
        }
    }
}

private extension UIColor {
    // "#RRGGBB" 형식만 지원 — 이 앱의 CSS 커스텀 프로퍼티(--bg)가 전부 이 형식이라
    // 그 이상은 필요 없다.
    convenience init?(mwhabitHex hex: String) {
        var s = hex
        if s.hasPrefix("#") { s.removeFirst() }
        guard s.count == 6, let value = UInt32(s, radix: 16) else { return nil }
        let r = CGFloat((value >> 16) & 0xFF) / 255.0
        let g = CGFloat((value >> 8) & 0xFF) / 255.0
        let b = CGFloat(value & 0xFF) / 255.0
        self.init(red: r, green: g, blue: b, alpha: 1)
    }
}
