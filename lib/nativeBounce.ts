/*
  iOS 전용 — 수강권 안내창(contentDrag 시트)이 열려 있는 동안만 WKWebView 문서의 세로 바운스(rubber-band)를 끈다.
  실기기 QA(2026-11-16): 시트를 끌 때 같은 동작인데 어떤 때는 닫히고 어떤 때는 문서 전체가 튕겨 화면 아래에 흰 빈 영역이 생겼다. 웹의 touchmove preventDefault 는
  "첫 touchmove 에서 호출해야" iOS 네이티브 스크롤을 막을 수 있어(이후는 cancelable=false) 손가락 속도에 따라 성공/실패가 갈린다 → 웹만으로는 항상 막을 수 없다.
  그래서 기존 NavigationPolicy 플러그인(NavigationPolicyPlugin.swift)의 `setVerticalBounceEnabled` 로 시트가 열린 동안만 scrollView.bounces 를 끄고 닫히면 복원한다
  (앱 전역 bounces=false 가 아님 — 다른 화면의 당겨서 튕기는 동작은 그대로).
  - 보유 카운트: 시트가 겹쳐 열려도 마지막 시트가 닫힐 때만 복원한다.
  - 안전장치: pagehide·visibility hidden 이면 복원, 다시 보이면(시트가 아직 열려 있을 때만) 재적용. 네이티브도 새 문서 로드·백그라운드 전환에서 스스로 복원한다.
  - 이미 배포된 앱(메서드 없음)·Android·웹에서는 no-op(웹의 touchmove 차단만 동작).
*/
import { Capacitor } from "@capacitor/core";

let holds = 0;
let listening = false;

type NavPlugin = { setVerticalBounceEnabled?: (o: { enabled: boolean }) => Promise<unknown> };
function setNative(enabled: boolean): void {
  try {
    if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== "ios") return;
    const plugin = (window as unknown as { Capacitor?: { Plugins?: { NavigationPolicy?: NavPlugin } } }).Capacitor?.Plugins?.NavigationPolicy;
    if (!plugin?.setVerticalBounceEnabled) return;
    plugin.setVerticalBounceEnabled({ enabled }).catch(() => {});
  } catch { /* 무시 — 실패해도 화면 동작에는 영향 없음(기존 바운스 유지) */ }
}

const onHide = () => { if (holds > 0) setNative(true); };
const onVisibility = () => { if (document.visibilityState === "hidden") onHide(); else if (holds > 0) setNative(false); };
function listen(on: boolean) {
  if (on === listening) return;
  listening = on;
  const f = on ? window.addEventListener.bind(window) : window.removeEventListener.bind(window);
  f("pagehide", onHide);
  (on ? document.addEventListener.bind(document) : document.removeEventListener.bind(document))("visibilitychange", onVisibility);
}

/** 바운스를 끈다. 반환된 함수를 부르면(시트 닫힘·언마운트) 복원 — 여러 번 불러도 한 번만 반영된다. */
export function acquireNoVerticalBounce(): () => void {
  holds++;
  if (holds === 1) { setNative(false); listen(true); }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds = Math.max(0, holds - 1);
    if (holds === 0) { setNative(true); listen(false); }
  };
}

/** 테스트용 */
export function __bounceHoldsForTests(): number { return holds; }
