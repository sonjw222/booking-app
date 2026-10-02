/*
  공유 — 네이티브 앱은 iOS Share Sheet(@capacitor/share), 웹은 Web Share API, 둘 다 없으면 링크 복사(기존 fallback 성격).
  결과: "shared" | "copied" | "cancelled" | "unsupported". 사용자 취소는 오류가 아니다.
*/
import { Capacitor } from "@capacitor/core";

export type ShareInput = { title: string; text?: string; url: string };
export type ShareResult = "shared" | "copied" | "cancelled" | "unsupported";

export async function shareLink(input: ShareInput): Promise<ShareResult> {
  try {
    if (Capacitor.isNativePlatform() && Capacitor.isPluginAvailable("Share")) {
      const { Share } = await import("@capacitor/share");
      await Share.share({ title: input.title, text: input.text, url: input.url, dialogTitle: input.title });
      return "shared";
    }
  } catch (e) {
    if (/cancel/i.test(String((e as Error)?.message ?? e))) return "cancelled";
    // 네이티브 공유 실패 시 아래 웹 경로로 이어서 시도
  }
  try {
    if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
      await navigator.share({ title: input.title, text: input.text, url: input.url });
      return "shared";
    }
  } catch (e) {
    if ((e as Error)?.name === "AbortError") return "cancelled";
  }
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(input.url);
      return "copied";
    }
  } catch { /* 무시 */ }
  return "unsupported";
}
