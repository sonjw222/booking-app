/*
  네이티브(iOS/Android, Capacitor) 푸시 알림 등록 — lib/webPush.ts의 네이티브 버전.
  - iOS 네이티브 WebView(WKWebView)는 VAPID 기반 웹푸시(lib/webPush.ts)를 지원하지 않아
    FCM(Firebase Cloud Messaging) 디바이스 토큰을 별도로 등록해야 한다.
  - 실제 발송은 동일한 supabase/functions/send-web-push가 담당(native_push_tokens 테이블도
    함께 조회해 FCM으로 보냄 — add_native_push_tokens.sql 참고).
  - 웹 브라우저에서는 Capacitor.isNativePlatform()이 false라 이 모듈의 함수는 전부 "지원
    안 함"으로 동작 — app/settings/notifications/page.tsx가 웹/네이티브를 분기해서 호출한다.
*/

import { Capacitor } from "@capacitor/core";
import { PushNotifications } from "@capacitor/push-notifications";
import { supabase } from "./supabaseClient";

export type NativePushStatus = "unsupported" | "subscribed" | "unsubscribed";

export function isNativePushSupported(): boolean {
  return Capacitor.isNativePlatform();
}

async function getMyAccountId(): Promise<string | null> {
  const { data: authData } = await supabase.auth.getUser();
  if (!authData?.user) return null;
  const { data: acc } = await supabase
    .from("accounts")
    .select("id")
    .eq("auth_id", authData.user.id)
    .single();
  return acc?.id ?? null;
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

  // registration/registrationError 리스너를 지우지 않고 누적 추가한다 — 전부 지우면
  // CapacitorBootstrap이 앱 부팅 시 등록해둔 pushNotificationActionPerformed(알림 탭)
  // 리스너까지 같이 사라진다. 사용자가 이 함수를 여러 번 눌러 리스너가 중복돼도 매번
  // 같은 토큰으로 upsert할 뿐이라 무해하다(이미 resolve된 Promise를 다시 resolve하는
  // 것도 아무 효과 없음).
  return new Promise((resolve) => {
    PushNotifications.addListener("registration", async (token) => {
      const { error } = await supabase.from("native_push_tokens").upsert(
        { account_id: accountId, platform, token: token.value },
        { onConflict: "token" }
      );
      resolve(error ? { ok: false, error: "토큰 저장에 실패했어요: " + error.message } : { ok: true });
    });

    PushNotifications.addListener("registrationError", (err) => {
      resolve({ ok: false, error: (err as { error?: string })?.error ?? "푸시 등록에 실패했어요" });
    });

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
