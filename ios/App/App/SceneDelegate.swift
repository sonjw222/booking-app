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

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}
