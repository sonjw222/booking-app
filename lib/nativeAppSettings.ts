/*
  네이티브(Android) 전용 — 시스템 "앱 정보" 설정 화면을 연다.
  - 위치/알림 권한을 "다시 묻지 않음"으로 거부하면 OS가 런타임 권한 다이얼로그를 다시
    띄워주지 않는다. 앱 안에서 재요청할 방법이 없어 유일한 복구 경로가 설정 화면이다.
  - Capacitor 코어에는 이걸 여는 API가 없어(공식 플러그인 아님) android/app/src/main/
    java/com/mwhabit/app/AppSettingsPlugin.java에 최소 플러그인 하나만 추가해뒀다.
  - iOS는 건드리지 않음(요구사항) — 이 모듈은 android가 아니면 항상 아무 것도 하지 않는다.
  - 웹 브라우저에서는 애초에 이 플러그인이 등록돼 있지 않아 호출하면 UNIMPLEMENTED
    에러가 나므로, isAppSettingsSupported()로 먼저 가드하고 호출한다.
*/

import { Capacitor, registerPlugin } from "@capacitor/core";

interface AppSettingsPlugin {
  open(): Promise<void>;
}

const AppSettings = registerPlugin<AppSettingsPlugin>("AppSettings");

export function isAppSettingsSupported(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android";
}

export async function openAppSettings(): Promise<void> {
  if (!isAppSettingsSupported()) return;
  try {
    await AppSettings.open();
  } catch {
    /* 실패해도 앱을 깨뜨리지 않음 — 사용자는 수동으로 설정을 열 수 있음 */
  }
}
