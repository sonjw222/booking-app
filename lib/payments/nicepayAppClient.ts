/* 이 WebView 가 모하빗 네이티브 앱(Capacitor iOS/Android)인지 — 서버에 "어느 앱인지" 힌트만 준다(서버가 설정으로 승인한 경우에만 앱 복귀 필드를 내려 준다). 웹 브라우저(PC·모바일)는 항상 null. */
import { Capacitor } from "@capacitor/core";
import { parseAppClient, type AppClient } from "./nicepayAppReturn";

export function getNicepayAppClient(): AppClient | null {
  try { return Capacitor.isNativePlatform() ? parseAppClient(Capacitor.getPlatform()) : null; } catch { return null; }
}
