import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        let bridgeViewController = CAPBridgeViewController()
        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = bridgeViewController
        window?.makeKeyAndVisible()

        // FcmTokenPlugin(ios/App/App/FcmTokenPlugin.swift)은 npm 패키지가 아닌 이 앱 전용
        // 네이티브 플러그인이라 capacitor.config.json의 packageClassList(npx cap sync가
        // 설치된 Capacitor npm 플러그인만 보고 자동 생성)에 안 실린다 — bridge가 만들어진
        // 직후(makeKeyAndVisible()이 loadView()를 트리거해 이 시점엔 이미 준비돼 있음)
        // 직접 등록한다(Android MainActivity.registerPlugin()과 동일한 역할, cap sync를
        // 다시 돌려도 이 코드는 지워지지 않음).
        bridgeViewController.bridge?.registerPluginInstance(FcmTokenPlugin())
        // AppleSignInPlugin.swift — 같은 이유로 직접 등록(npm 패키지가 아닌 이 앱 전용
        // 네이티브 플러그인이라 npx cap sync가 자동으로 못 실음).
        bridgeViewController.bridge?.registerPluginInstance(AppleSignInPlugin())
        // WebViewThemePlugin.swift — 같은 이유로 직접 등록. JS가 명시적 테마를 알려주기
        // 전까지(하이드레이션 전 인라인 스크립트가 곧바로 부르지만, 이론상 그 사이 아주
        // 짧은 프레임 동안) iOS 시스템 라이트/다크 설정을 자동으로 따라가는 동적 색을
        // baseline으로 깔아둔다 — "시스템 설정 따르기"가 기본값인 사용자는 이것만으로
        // 이미 오버스크롤 배경이 맞는다.
        bridgeViewController.bridge?.registerPluginInstance(WebViewThemePlugin())
        if let webView = bridgeViewController.bridge?.webView {
            let dynamicBg = UIColor { traits in
                traits.userInterfaceStyle == .dark
                    ? UIColor(red: 0x17 / 255.0, green: 0x18 / 255.0, blue: 0x1C / 255.0, alpha: 1)
                    : UIColor(red: 0xFB / 255.0, green: 0xFB / 255.0, blue: 0xFA / 255.0, alpha: 1)
            }
            webView.backgroundColor = dynamicBg
            webView.scrollView.backgroundColor = dynamicBg
            if #available(iOS 15.0, *) {
                webView.underPageBackgroundColor = dynamicBg
            }
        }

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}
