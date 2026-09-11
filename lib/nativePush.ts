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
  console.log(`[nativePush] permission status: ${permStatus.receive}`);
  if (permStatus.receive === "prompt") {
    console.log("[nativePush] requesting permission");
    permStatus = await PushNotifications.requestPermissions();
    console.log(`[nativePush] permission after request: ${permStatus.receive}`);
  }
  if (permStatus.receive !== "granted") {
    return { ok: false, error: "알림 권한이 거부됐어요. 기기 설정에서 허용해주세요" };
  }

  const platform = Capacitor.getPlatform();
  if (platform !== "ios" && platform !== "android") {
    return { ok: false, error: "지원하지 않는 플랫폼이에요" };
  }

  async function saveToken(token: string): Promise<{ ok: boolean; error?: string }> {
    console.log("[nativePush] token obtained, upserting to native_push_tokens"); // 토큰 값 자체는 절대 로그에 남기지 않음
    const { error } = await supabase.from("native_push_tokens").upsert(
      { account_id: accountId, platform, token },
      { onConflict: "token" }
    );
    console.log(`[nativePush] native_push_tokens upsert: ${error ? "failed — " + error.message : "success"}`);
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
      console.log(`[nativePush] registration error: ${(err as { error?: string })?.error ?? "unknown"}`);
      resolve({ ok: false, error: (err as { error?: string })?.error ?? "푸시 등록에 실패했어요" });
    });

    // iOS/Android 공통 — UIApplication.registerForRemoteNotifications()를 트리거한다.
    // iOS에선 이 호출이 결국 AppDelegate의 didRegisterForRemoteNotificationsWithDeviceToken을
    // 거쳐 Firebase Messaging → FcmToken 플러그인으로 이어진다.
    console.log(`[nativePush] calling PushNotifications.register() (platform: ${platform})`);
    PushNotifications.register();
  });
}

// 로그인 완료(SIGNED_IN/INITIAL_SESSION) 시 자동으로 호출한다(app/components/SessionWatcher.tsx).
// 실기기 진단 결과(2026-09-11) — enableNativePush()가 그동안 app/settings/notifications
// 화면의 토글을 눌러야만 호출되는 구조였다: 그 화면을 스스로 찾아가 토글하는 사용자가
// 없으면 PushNotifications.requestPermissions()/register()가 단 한 번도 실행되지 않아,
// iOS/Android 둘 다 설정 앱의 알림 목록에 이 앱 자체가 아예 안 뜨는 상태였다(권한을
// "거부"한 게 아니라 "물어본 적이 없음"). 이 함수가 그 공백을 메운다.
//
// "이미 subscribed"면 그냥 반환한다 — 매 로그인/앱 재실행마다 불필요하게 register()를
// 다시 부르고 같은 토큰을 다시 upsert하지 않기 위함(egress 절제). "denied"(명시적으로
// 거부)여도 이 함수를 그냥 호출은 하되, enableNativePush() 내부 로직상
// checkPermissions().receive가 'prompt'가 아니면 requestPermissions() 자체를 안 부르므로
// OS 팝업이 다시 뜨지 않는다 — "거부 후 매 앱 시작마다 팝업 반복" 문제가 OS 레벨에서
// 자연히 방지된다(추가 상태 저장 불필요).
export async function autoRegisterNativePushOnLogin(): Promise<void> {
  if (!isNativePushSupported()) return;
  try {
    const status = await getNativePushStatus();
    if (status === "subscribed") return;
    const result = await enableNativePush();
    if (!result.ok) console.log(`[nativePush] auto-register on login skipped/failed: ${result.error}`);
  } catch (e) {
    // 네이티브 브릿지 예외가 나도 로그인 흐름 자체는 절대 막지 않는다(요구사항 7 —
    // 권한/등록 실패로 앱이 크래시하거나 로그인이 막히면 안 됨).
    console.log(`[nativePush] auto-register on login threw: ${e instanceof Error ? e.message : String(e)}`);
  }
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
