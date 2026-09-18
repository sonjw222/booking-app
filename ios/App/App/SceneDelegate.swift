import UIKit
import Capacitor
import GoogleSignIn

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
        // GoogleSignInPlugin.swift — 같은 이유로 직접 등록.
        bridgeViewController.bridge?.registerPluginInstance(GoogleSignInPlugin())
        // NavigationPolicyPlugin.swift — 같은 이유로 직접 등록. root 화면에서 edge-swipe
        // 뒤로가기를 끄는 데 쓴다(릴리스 폴리시 배치 8차, 아래 allowsBackForwardNavigationGestures
        // 주석 참고).
        bridgeViewController.bridge?.registerPluginInstance(NavigationPolicyPlugin())
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

            // 실기기 QA(2026-09-14) — "당겨도 전혀 안 튕긴다"는 신고 대응. WKWebView는
            // 콘텐츠 높이가 뷰포트보다 짧은 화면(로그인, 빈 알림함 등)에서는
            // alwaysBounceVertical 없이는 기본적으로 rubber-band가 아예 발생하지 않는다
            // (콘텐츠가 실제로 넘칠 때만 자동으로 튕김) — 명시적으로 켜서 모든 화면에서
            // 일관되게 당겨지는 느낌을 보장한다. bounces는 Capacitor/WKWebView 기본값이
            // 이미 true지만, 다른 곳에서 의도치 않게 꺼지는 걸 방지하기 위해 여기서도
            // 명시한다.
            webView.scrollView.bounces = true
            webView.scrollView.alwaysBounceVertical = true

            // 실기기 QA(2026-09-14) — iOS 좌측 엣지 스와이프 뒤로가기가 전혀 동작하지
            // 않는다는 신고 대응. WKWebView는 이 프로퍼티가 기본 false라 명시적으로 켜야
            // 한다 — 브라우저 세션 히스토리(History API, Next.js router가 내부적으로 쓰는
            // pushState 포함) 기준으로 동작하므로 이 앱의 <Link> 기반 탭 전환과도 자연스럽게
            // 맞물린다(탭을 여러 개 거쳐온 뒤 스와이프하면 거쳐온 탭들을 순서대로 되짚는
            // 것 — 일반 웹/Safari와 동일한 정상 동작, 별도로 억제하지 않음).
            //
            // 릴리스 폴리시 배치 8차(2026-09-17) — 이 전역 기본값(true)은 콜드 스타트 초기
            // 프레임과 이 값이 아직 맞지 않은 아주 짧은 순간을 위한 baseline일 뿐이다.
            // 실제로는 app/components/NavigationPolicy.tsx가 화면(경로)이 바뀔 때마다
            // NavigationPolicyPlugin을 통해 이 값을 다시 계산해 덮어쓴다 — root 화면
            // (홈/예약/내예약/알림/마이, 수업/회원/알림/더보기, 운영 홈)에서는 false로 꺼서
            // edge swipe로 로그인 화면·이전 모드가 뒤에서 보이는 문제를 막고, 상세 화면에서는
            // true로 켜서 기존 정상 back은 그대로 유지한다.
            webView.allowsBackForwardNavigationGestures = true
        }

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        // GoogleSignIn SDK는 로그인 시트가 시스템으로 돌아올 때(리버스 클라이언트 ID
        // URL scheme) 이 콜백으로 완료 처리를 받아야 한다(Google 공식 SDK 요구사항) —
        // 우리 앱 URL이면 GIDSignIn이 처리하고 true를 반환, 아니면 false라 기존 로직에
        // 영향 없음.
        for context in URLContexts {
            if GIDSignIn.sharedInstance.handle(context.url) {
                return
            }
        }
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}
