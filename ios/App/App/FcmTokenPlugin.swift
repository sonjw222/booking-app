import Foundation
import Capacitor
import FirebaseMessaging

/*
  iOS 전용 — 공식 @capacitor/push-notifications 플러그인의 "registration" 이벤트는 APNs
  원시 디바이스 토큰을 주는데(node_modules/@capacitor/push-notifications/ios/Sources/
  PushNotificationsPlugin/PushNotificationsPlugin.swift의
  didRegisterForRemoteNotificationsWithDeviceToken 확인함 — Data를 그대로 hex 문자열로
  바꿔 "registration"에 실어 보낼 뿐), FCM(Firebase Cloud Messaging) 발송에는 그 값이
  아니라 별도의 FCM 등록 토큰이 필요하다(AppDelegate가 APNs 토큰을
  Messaging.messaging().apnsToken에 넘기면 Firebase가 내부적으로 교환/발급한다).

  이 토큰을 JS로 넘겨주는 공식 Capacitor 플러그인이 없어(별도 npm 패키지
  @capacitor-firebase/messaging을 새로 추가하는 대신) Android의
  android/app/src/main/java/com/mwhabit/app/AppSettingsPlugin.java와 같은 패턴으로 최소
  커스텀 플러그인만 추가한다.

  등록 방식: npm 패키지가 아니라 이 앱에만 있는 네이티브 전용 플러그인이라 `npx cap sync`가
  capacitor.config.json의 packageClassList에 자동으로 추가해주지 않는다(그 목록은 설치된
  Capacitor npm 플러그인만 기준으로 생성됨) — 대신 SceneDelegate.swift에서 bridge가 만들어진
  직후 registerPluginInstance()로 직접 등록한다(Android의 MainActivity.registerPlugin()과
  동일한 역할이고, cap sync를 다시 돌려도 지워지지 않음).

  JS 쪽 소비: lib/nativePush.ts가 @capacitor/core의 registerPlugin("FcmToken")으로 이
  플러그인을 사용 — jsName이 "FcmToken"인 이유.
*/
@objc(FcmTokenPlugin)
public class FcmTokenPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "FcmTokenPlugin"
    public let jsName = "FcmToken"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getToken", returnType: CAPPluginReturnPromise)
    ]

    override public func load() {
        FcmTokenBridge.shared.plugin = self
    }

    // 이미 발급된(캐시된) FCM 토큰을 즉시 반환 — JS가 리스너를 등록하기 전에
    // AppDelegate 쪽 MessagingDelegate 콜백이 먼저 와버린 레이스를 커버하기 위함
    // (notifyListeners는 그 시점에 붙어있는 리스너가 없으면 그냥 아무 일도 안 하고
    // 사라짐 — 나중에 값을 다시 못 받음). 아직 없으면 빈 문자열을 주고, 이후
    // "fcmTokenReceived" 이벤트로 최신값을 받으면 된다.
    @objc func getToken(_ call: CAPPluginCall) {
        call.resolve(["value": FcmTokenBridge.shared.latestToken ?? ""])
    }
}

/*
  AppDelegate(MessagingDelegate 구현)와 FcmTokenPlugin(CAPPlugin, Capacitor bridge가
  준비된 뒤에만 존재) 사이를 잇는 싱글턴. Firebase가 토큰을 넘겨주는 시점이 Capacitor
  bridge/플러그인 초기화보다 이를 수 있어(앱 시작 직후) 최신 토큰 값을 항상 캐싱해두고,
  플러그인이 준비되면(load()) 그 시점의 캐시값을 getToken()으로 즉시 조회할 수 있게 한다.
*/
final class FcmTokenBridge {
    static let shared = FcmTokenBridge()
    private init() {}

    private(set) var latestToken: String?
    weak var plugin: FcmTokenPlugin?

    func didReceiveToken(_ token: String) {
        latestToken = token
        plugin?.notifyListeners("fcmTokenReceived", data: ["value": token])
    }
}
