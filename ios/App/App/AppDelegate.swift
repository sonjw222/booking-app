import UIKit
import Capacitor
import FirebaseCore
import FirebaseMessaging

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Override point for customization after application launch.
        // FCM 네이티브 푸시(add_native_push_tokens.sql, supabase/functions/send-web-push,
        // ios/App/App/FcmTokenPlugin.swift 참고) — FirebaseApp.configure()는 앱 시작 시
        // 정확히 한 번만 호출돼야 한다(중복 호출은 크래시를 유발할 수 있어 이 한 곳에만 둠).
        // GoogleService-Info.plist(사용자가 Xcode로 이미 프로젝트에 추가함, 여기선 안 건드림)를
        // 자동으로 읽어 초기화한다.
        FirebaseApp.configure()
        Messaging.messaging().delegate = self
        return true
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.
        // If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Restart any tasks that were paused (or not yet started) while the application was inactive. If the application was previously in the background, optionally refresh the user interface.
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    func application(_ application: UIApplication,
                     configurationForConnecting connectingSceneSession: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let config = UISceneConfiguration(name: "Default Configuration",
                                          sessionRole: connectingSceneSession.role)
        config.delegateClass = SceneDelegate.self
        return config
    }

    // 공식 @capacitor/push-notifications 플러그인이 "registration"/"registrationError"
    // JS 이벤트를 만들려면 이 두 콜백을 NotificationCenter로 브릿지해줘야 한다(플러그인
    // 소스의 옵저버가 .capacitorDidRegisterForRemoteNotifications를 구독 — Capacitor 공식
    // 문서에 명시된 필수 연동, 기존엔 이 파일에 없었음). 기존 동작(권한 요청/register()
    // 트리거는 계속 그 플러그인 것을 그대로 씀, PushNotifications.checkPermissions 등)은
    // 그대로 유지하고, 추가로 APNs 토큰을 Firebase Messaging에 넘겨 FCM 등록 토큰으로
    // 교환한다(공식 방식 — apnsToken 세터가 내부적으로 트리거).
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Messaging.messaging().apnsToken = deviceToken
        NotificationCenter.default.post(name: .capacitorDidRegisterForRemoteNotifications, object: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NotificationCenter.default.post(name: .capacitorDidFailToRegisterForRemoteNotifications, object: error)
    }
}

extension AppDelegate: MessagingDelegate {
    // Firebase가 FCM 등록 토큰을 (최초 발급 시·갱신 시) 호출해서 알려준다 — 이 값이 실제로
    // FCM HTTP v1 messages:send에 쓸 수 있는 토큰이다(APNs 원시 토큰과는 다른 값).
    // FcmTokenPlugin을 통해 JS(lib/nativePush.ts)로 전달한다.
    func messaging(_ messaging: Messaging, didReceiveRegistrationToken fcmToken: String?) {
        guard let fcmToken = fcmToken else { return }
        FcmTokenBridge.shared.didReceiveToken(fcmToken)
    }
}
