/*
  웹 푸시 구독 (P1-3 일부).
  - 브라우저 알림 권한 요청 → 서비스 워커 등록 → PushManager 구독 → DB에 저장(push_subscriptions)
  - 실제 발송은 supabase/functions/send-web-push (pg_cron이 1분마다 호출)가 담당한다.
  - 카카오 알림톡/SMS는 사업자 등록이 필요해 범위 밖(docs/TODO.md P1-3).
*/

import { supabase } from "./supabaseClient";

const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? "";

export type WebPushStatus = "unsupported" | "subscribed" | "unsubscribed";

function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(rawData.length));
  for (let i = 0; i < rawData.length; i++) bytes[i] = rawData.charCodeAt(i);
  return bytes;
}

export function isWebPushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window &&
    !!VAPID_PUBLIC_KEY
  );
}

export async function getWebPushStatus(): Promise<WebPushStatus> {
  if (!isWebPushSupported()) return "unsupported";
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    return sub ? "subscribed" : "unsubscribed";
  } catch {
    return "unsubscribed";
  }
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

export async function enableWebPush(): Promise<{ ok: boolean; error?: string }> {
  if (!isWebPushSupported()) {
    return { ok: false, error: "이 브라우저는 푸시 알림을 지원하지 않아요" };
  }

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    return { ok: false, error: "알림 권한이 거부됐어요. 브라우저 설정에서 허용해주세요" };
  }

  try {
    const reg = await navigator.serviceWorker.register("/sw.js");
    await navigator.serviceWorker.ready;

    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      });
    }

    const accountId = await getMyAccountId();
    if (!accountId) return { ok: false, error: "로그인이 필요해요" };

    const json = sub.toJSON();
    const { error } = await supabase.from("push_subscriptions").upsert(
      {
        account_id: accountId,
        endpoint: sub.endpoint,
        p256dh: json.keys?.p256dh ?? "",
        auth: json.keys?.auth ?? "",
        user_agent: navigator.userAgent,
      },
      { onConflict: "endpoint" }
    );
    if (error) return { ok: false, error: "구독 정보 저장에 실패했어요: " + error.message };

    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "푸시 구독에 실패했어요" };
  }
}

export async function disableWebPush(): Promise<{ ok: boolean; error?: string }> {
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    if (sub) {
      await supabase.from("push_subscriptions").delete().eq("endpoint", sub.endpoint);
      await sub.unsubscribe();
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "구독 해제에 실패했어요" };
  }
}
