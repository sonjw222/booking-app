/*
  네이티브(iOS/Android, Capacitor) 푸시 알림 등록 — lib/webPush.ts의 네이티브 버전.
  - iOS 네이티브 WebView(WKWebView)는 VAPID 기반 웹푸시(lib/webPush.ts)를 지원하지 않아
    FCM(Firebase Cloud Messaging) 디바이스 토큰을 별도로 등록해야 한다.
  - 실제 발송은 동일한 supabase/functions/send-web-push가 담당(native_push_tokens 테이블도
    함께 조회해 FCM으로 보냄 — add_native_push_tokens.sql 참고).
  - 웹 브라우저에서는 Capacitor.isNativePlatform()이 false라 이 모듈의 함수는 전부 "지원
    안 함"으로 동작 — app/settings/notifications/page.tsx가 웹/네이티브를 분기해서 호출한다.
*/

import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import { PushNotifications } from "@capacitor/push-notifications";
import { supabase } from "./supabaseClient";
import { getMyAccountId } from "./authAccount";

// iOS 전용 커스텀 네이티브 플러그인(ios/App/App/FcmTokenPlugin.swift, npm 패키지 아님 —
// 이 앱에만 있는 네이티브 코드라 registerPlugin으로 직접 연결) — 공식 PushNotifications의
// "registration" 이벤트가 iOS에서는 APNs 원시 디바이스 토큰만 주기 때문에(FCM 발송엔 못 씀,
// PushNotificationsPlugin.swift 소스 확인함) AppDelegate가 Firebase Messaging으로 교환한
// 진짜 FCM 등록 토큰을 이 플러그인이 대신 넘겨준다. Android는 필요 없음(Capacitor
// PushNotifications의 "registration" 이벤트가 이미 FCM 토큰 그 자체).
interface FcmTokenPlugin {
  getToken(): Promise<{ value: string }>;
  addListener(
    eventName: "fcmTokenReceived",
    listenerFunc: (data: { value: string }) => void
  ): Promise<PluginListenerHandle> & PluginListenerHandle;
}
const FcmToken = registerPlugin<FcmTokenPlugin>("FcmToken");

export type NativePushStatus = "unsupported" | "subscribed" | "unsubscribed";

export function isNativePushSupported(): boolean {
  return Capacitor.isNativePlatform();
}

export async function getNativePushStatus(): Promise<NativePushStatus> {
  if (!isNativePushSupported()) return "unsupported";
  try {
    const { receive } = await PushNotifications.checkPermissions();
    return receive === "granted" ? "subscribed" : "unsubscribed";
  } catch {
    return "unsubscribed";
  }
}

export async function enableNativePush(): Promise<{ ok: boolean; error?: string }> {
  if (!isNativePushSupported()) {
    return { ok: false, error: "네이티브 앱에서만 사용할 수 있어요" };
  }

  const accountId = await getMyAccountId();
  if (!accountId) return { ok: false, error: "로그인이 필요해요" };

  let permStatus = await PushNotifications.checkPermissions();
  if (permStatus.receive === "prompt") {
    permStatus = await PushNotifications.requestPermissions();
  }
  if (permStatus.receive !== "granted") {
    return { ok: false, error: "알림 권한이 거부됐어요. 기기 설정에서 허용해주세요" };
  }

  const platform = Capacitor.getPlatform();
  if (platform !== "ios" && platform !== "android") {
    return { ok: false, error: "지원하지 않는 플랫폼이에요" };
  }

  async function saveToken(token: string): Promise<{ ok: boolean; error?: string }> {
    const { error } = await supabase.from("native_push_tokens").upsert(
      { account_id: accountId, platform, token },
      { onConflict: "token" }
    );
    return error ? { ok: false, error: "토큰 저장에 실패했어요: " + error.message } : { ok: true };
  }

  // 리스너를 지우지 않고 누적 추가한다 — 전부 지우면 CapacitorBootstrap이 앱 부팅 시
  // 등록해둔 pushNotificationActionPerformed(알림 탭) 리스너까지 같이 사라진다. 사용자가
  // 이 함수를 여러 번 눌러 리스너가 중복돼도 매번 같은 토큰으로 upsert할 뿐이라 무해하다
  // (이미 resolve된 Promise를 다시 resolve하는 것도 아무 효과 없음).
  return new Promise((resolve) => {
    if (platform === "ios") {
      // iOS: 공식 PushNotifications의 "registration" 이벤트가 APNs 원시 토큰이라 FCM에
      // 못 쓴다 — AppDelegate가 Firebase Messaging으로 교환한 진짜 FCM 토큰을 커스텀
      // FcmToken 플러그인의 "fcmTokenReceived" 이벤트로 받는다(위 import 주석 참고).
      FcmToken.addListener("fcmTokenReceived", (data) => {
        void saveToken(data.value).then(resolve);
      });
      // AppDelegate 쪽 MessagingDelegate 콜백이 이 리스너 등록보다 먼저 왔을 수 있어(레이스)
      // 캐시된 값을 즉시 한 번 조회 — 비어있으면 위 리스너가 나중에 처리한다.
      FcmToken.getToken()
        .then(({ value }) => {
          if (value) void saveToken(value).then(resolve);
        })
        .catch(() => {});
    } else {
      // Android: Capacitor PushNotifications의 "registration" 이벤트가 이미 FCM 토큰
      // 그 자체라 별도 브릿지가 필요 없다(기존 동작 그대로).
      PushNotifications.addListener("registration", (token) => {
        void saveToken(token.value).then(resolve);
      });
    }

    PushNotifications.addListener("registrationError", (err) => {
      resolve({ ok: false, error: (err as { error?: string })?.error ?? "푸시 등록에 실패했어요" });
    });

    // iOS/Android 공통 — UIApplication.registerForRemoteNotifications()를 트리거한다.
    // iOS에선 이 호출이 결국 AppDelegate의 didRegisterForRemoteNotificationsWithDeviceToken을
    // 거쳐 Firebase Messaging → FcmToken 플러그인으로 이어진다.
    PushNotifications.register();
  });
}

export async function disableNativePush(): Promise<{ ok: boolean; error?: string }> {
  if (!isNativePushSupported()) return { ok: true };
  try {
    // 이 기기가 마지막으로 등록한 토큰 값을 다시 조회하는 API가 Capacitor에 없어(등록
    // 이벤트 시점에만 값을 받음), 이 계정·이 플랫폼의 토큰을 전부 지운다 — 같은 계정으로
    // 여러 기기에서 로그인했다면 다른 기기 구독까지 같이 꺼질 수 있다(허용된 트레이드오프,
    // 다시 켜면 재등록됨).
    const accountId = await getMyAccountId();
    if (!accountId) return { ok: true };
    const platform = Capacitor.getPlatform();
    await supabase
      .from("native_push_tokens")
      .delete()
      .eq("account_id", accountId)
      .eq("platform", platform);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "구독 해제에 실패했어요" };
  }
}

// 알림 탭 시 링크로 이동(웹의 public/sw.js notificationclick과 동일 개념) — 앱 부팅 시
// CapacitorBootstrap에서 1회만 등록한다.
export function registerNativePushTapHandler(onNavigate: (link: string) => void): void {
  if (!isNativePushSupported()) return;
  PushNotifications.addListener("pushNotificationActionPerformed", (action) => {
    const link = (action.notification?.data as { link?: string } | undefined)?.link;
    if (typeof link === "string") onNavigate(link);
  });
}
