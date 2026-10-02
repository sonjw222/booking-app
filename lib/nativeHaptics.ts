/*
  절제된 햅틱 — 결과가 분명한 주요 action(예약 완료, 예약 취소 완료, 결제 완료)에만 사용한다. 모든 버튼/탭에는 쓰지 않는다.
  네이티브 앱에서만 동작하고, 플러그인이 없는 구버전 앱/웹에서는 조용히 무시한다(예외 전파 없음).
*/
import { Capacitor } from "@capacitor/core";

async function notify(kind: "Success" | "Warning"): Promise<void> {
  try {
    if (!Capacitor.isNativePlatform() || !Capacitor.isPluginAvailable("Haptics")) return;
    const { Haptics, NotificationType } = await import("@capacitor/haptics");
    await Haptics.notification({ type: NotificationType[kind] });
  } catch { /* 햅틱은 부가 기능 — 실패해도 흐름에 영향 없음 */ }
}

export const hapticSuccess = () => notify("Success");   // 예약 완료 / 결제 완료
export const hapticWarning = () => notify("Warning");   // 예약 취소 확인 완료(되돌릴 수 없는 처리)
