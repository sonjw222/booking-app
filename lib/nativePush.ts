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

// P1 버그 수정(2026-09-20, 실기기 QA) — "OS 알림 권한이 granted"와 "이 기기가 실제로
// FCM에 등록돼 서버(native_push_tokens)에 토큰이 저장돼 있다"는 서로 다른 상태인데
// getNativePushStatus()가 이 둘을 같은 것으로 취급했다. 권한은 앱 설치 이력이나 OS
// 정책에 따라 이 코드가 생기기 전에도 이미 granted였을 수 있어("거부한 적 없음"과
// "실제로 등록함"은 다름), permission만 보고 subscribed로 판정하면
// autoRegisterNativePushOnLogin()이 실제로는 한 번도 register()를 호출한 적 없는
// 기기에서도 "이미 구독 중"이라 착각해 등록 자체를 건너뛴다 — 실기기 logcat으로
// 재현·확인함(PushNotifications.register() 호출 없음, FCM registration 이벤트 없음,
// native_push_tokens 빈 테이블).
//
// "이 기기가 등록을 마쳤는지"를 account_id+platform으로 DB를 조회해 판정하지 않는다
// (요구사항) — 같은 계정으로 여러 대의 Android/iOS 기기를 쓸 수 있어, 다른 기기가
// 이미 등록한 토큰이 있어도 "지금 이 기기"는 미등록일 수 있기 때문이다. 대신 이
// 기기(앱 설치본)에 로컬로만 저장되는 localStorage 플래그로 판정한다 — 이미
// lib/notifications.ts의 NOTI_PREF_STORAGE_KEY와 동일한 패턴(try/catch로 감싸 조용히
// 무시). saveToken()이 실제로 upsert에 성공했을 때만 이 플래그를 세운다(아래).
const DEVICE_REGISTERED_STORAGE_KEY = "native_push_device_registered";

export function isDeviceRegisteredLocally(): boolean {
  try {
    return localStorage.getItem(DEVICE_REGISTERED_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function markDeviceRegisteredLocally(): void {
  try {
    localStorage.setItem(DEVICE_REGISTERED_STORAGE_KEY, "1");
  } catch { /* 무시 */ }
}

// disableNativePush()(로그아웃 등)에서 호출 — 이 로컬 플래그를 안 지우면, 서버 쪽
// native_push_tokens 행은 삭제됐는데 다음 로그인(같은 계정 재로그인이든 같은 기기에서
// 다른 계정으로 로그인이든) 때 getNativePushStatus()가 여전히 "subscribed"로 잘못
// 판정해 재등록을 건너뛰는 같은 종류의 버그가 재발한다.
export function clearDeviceRegisteredLocally(): void {
  try {
    localStorage.removeItem(DEVICE_REGISTERED_STORAGE_KEY);
  } catch { /* 무시 */ }
}

export async function getNativePushStatus(): Promise<NativePushStatus> {
  if (!isNativePushSupported()) return "unsupported";
  try {
    const { receive } = await PushNotifications.checkPermissions();
    if (receive !== "granted") return "unsubscribed";
    return isDeviceRegisteredLocally() ? "subscribed" : "unsubscribed";
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
    if (!error) markDeviceRegisteredLocally();
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
// "이미 subscribed"(권한 granted + 이 기기가 실제로 등록 완료)면 그냥 반환한다 — 매
// 로그인/앱 재실행마다 불필요하게 register()를 다시 부르고 같은 토큰을 다시 upsert하지
// 않기 위함(egress 절제). "denied"(명시적으로 거부)여도 이 함수를 그냥 호출은 하되,
// enableNativePush() 내부 로직상 checkPermissions().receive가 'prompt'가 아니면
// requestPermissions() 자체를 안 부르므로 OS 팝업이 다시 뜨지 않는다 — "거부 후 매 앱
// 시작마다 팝업 반복" 문제가 OS 레벨에서 자연히 방지된다(추가 상태 저장 불필요).
//
// 모듈 스코프 in-flight 잠금(2026-09-20 추가) — SessionWatcher.tsx의
// onAuthStateChange가 SIGNED_IN/INITIAL_SESSION을 같은 앱 세션 안에서 짧은 간격으로
// 여러 번 쏠 수 있다(예: 앱 부팅 시 INITIAL_SESSION 직후 토큰 갱신으로 SIGNED_IN 재발생
// 등). 이전에는 매번 독립적으로 enableNativePush()를 불러 PushNotifications.register()
// 호출과 리스너 등록이 중첩될 수 있었다(리스너 자체는 안 지워도 무해하다고 기존 주석에
// 적혀 있었지만, register() 중복 호출과 upsert 중복 실행까지 막을 이유는 없다) — 진행
// 중인 시도가 있으면 그 Promise를 그대로 재사용해 중복 호출을 없앤다. 시도가 끝나면
// (성공이든 실패든) 잠금을 풀어, 이후의 별도 로그인 이벤트(예: 다른 계정으로 재로그인)는
// 새로 시도할 수 있게 한다.
let inFlightAutoRegister: Promise<void> | null = null;

export async function autoRegisterNativePushOnLogin(): Promise<void> {
  if (!isNativePushSupported()) return;
  if (inFlightAutoRegister) return inFlightAutoRegister;

  inFlightAutoRegister = (async () => {
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
  })();

  try {
    await inFlightAutoRegister;
  } finally {
    inFlightAutoRegister = null;
  }
}

export async function disableNativePush(): Promise<{ ok: boolean; error?: string }> {
  if (!isNativePushSupported()) return { ok: true };
  // 로컬 "이 기기 등록 완료" 플래그도 항상 같이 지운다(계정 조회 성공 여부와 무관하게
  // 맨 먼저) — 안 지우면 서버 쪽 native_push_tokens 행은 삭제됐는데 getNativePushStatus()가
  // 여전히 "subscribed"로 잘못 판정해, 다음 로그인(같은 계정 재로그인이든 같은 기기에서
  // 다른 계정으로 로그인이든) 때 재등록을 건너뛰는 동일한 버그가 재발한다.
  clearDeviceRegisteredLocally();
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

// Android/iOS 네이티브 푸시 foreground presentation 버그 수정(2026-09-21, 실기기 QA) —
// 실기기(Firebase Console Test Message)로 확인: background/terminated 상태에선 OS가
// 시스템 알림(heads-up/notification shade)을 자동으로 띄워줬지만, 앱이 foreground일
// 땐 사용자에게 보이는 게 아무 것도 없었다. FCM Android SDK의 표준 동작이 원인이다 —
// 앱이 foreground면 OS가 시스템 알림을 절대 자동으로 띄우지 않고(중복 방지를 위한
// 의도된 설계), 대신 PushNotifications의 "pushNotificationReceived" 이벤트로만 앱에
// 전달한다. 이 앱 코드는 "pushNotificationActionPerformed"(탭)만 듣고 있었고
// "pushNotificationReceived"는 어디서도 리스닝하지 않아 — 이벤트 자체는 정상적으로
// 오는데 받는 쪽이 없어 그냥 버려지고 있었다(실기기 logcat으로 직접 확인).
//
// background/terminated 상태의 시스템 알림과 절대 중복되면 안 된다 — 이 이벤트는
// FCM Android SDK 설계상 앱이 foreground일 때만 발생하므로(백그라운드/종료 상태에선
// 아예 이 JS 이벤트 자체가 안 옴, OS가 시스템 트레이로 직행), 이 함수가 여는 인앱
// 배너는 구조적으로 foreground 전용이라 별도 상태 체크 없이도 중복이 발생할 수 없다.
//
// UI는 새 React 컴포넌트/상태 대신 바닐라 DOM으로 직접 만든다 — 이 앱은 탭/페이지
// 전환마다 전체 페이지가 새로 로드되는 구조라(app/layout.tsx 주석 참고) 이 리스너를
// 등록하는 CapacitorBootstrap 쪽도 페이지마다 다시 마운트되는 평범한 useEffect일 뿐,
// 전역 React 상태 관리자가 없다 — 기존 페이지별 .toast(React state)와 달리, 어느
// 화면에 있든 상관없이 즉시 띄울 수 있어야 하므로 document.body에 직접 붙이는 편이
// 가장 단순하고 확실하다.
let foregroundBannerEl: HTMLElement | null = null;

function showForegroundPushBanner(title: string, body: string, onTap: () => void): void {
  // 이미 배너가 떠 있으면 내용만 교체(쌓이지 않게) — 알림이 짧은 간격으로 연달아
  // 와도 배너가 여러 개 겹쳐 쌓이는 일이 없다.
  if (foregroundBannerEl) {
    foregroundBannerEl.remove();
    foregroundBannerEl = null;
  }

  const el = document.createElement("div");
  el.className = "push-foreground-banner";
  el.setAttribute("role", "button");
  el.setAttribute("tabindex", "0");

  const dot = document.createElement("span");
  dot.className = "push-foreground-banner-dot";

  const textWrap = document.createElement("div");
  textWrap.className = "push-foreground-banner-body";

  const titleEl = document.createElement("p");
  titleEl.className = "push-foreground-banner-title";
  titleEl.textContent = title || "모하빗";

  const bodyEl = document.createElement("p");
  bodyEl.className = "push-foreground-banner-text";
  bodyEl.textContent = body;

  textWrap.appendChild(titleEl);
  textWrap.appendChild(bodyEl);
  el.appendChild(dot);
  el.appendChild(textWrap);

  let dismissTimer: ReturnType<typeof setTimeout>;
  const dismiss = () => {
    clearTimeout(dismissTimer);
    el.classList.remove("is-visible");
    setTimeout(() => el.remove(), 200); // transition(180ms) 끝난 뒤 DOM에서 제거
    if (foregroundBannerEl === el) foregroundBannerEl = null;
  };
  el.addEventListener("click", () => {
    dismiss();
    onTap();
  });

  document.body.appendChild(el);
  foregroundBannerEl = el;
  // 붙인 직후 바로 클래스를 주면 transition이 안 먹을 수 있어(같은 프레임) 한 틱 뒤로 미룬다.
  requestAnimationFrame(() => el.classList.add("is-visible"));
  dismissTimer = setTimeout(dismiss, 4000);
}

// 앱 부팅 시 CapacitorBootstrap에서 registerNativePushTapHandler와 함께 1회만 등록한다.
export function registerNativePushForegroundHandler(onNavigate: (link: string) => void): void {
  if (!isNativePushSupported()) return;
  PushNotifications.addListener("pushNotificationReceived", (notification) => {
    // Android 알림 아이콘 실기기 QA(2026-09-21) — Android만 data-only FCM 메시지로
    // 바뀌어(MwhabitMessagingService.java, supabase/functions/send-web-push 주석 참고)
    // title/body가 최상위가 아니라 notification.data 안에 들어온다. iOS는 여전히
    // "notification" 타입 payload라 최상위 title/body가 그대로 채워지므로, 최상위 값이
    // 없을 때만 data를 보는 순서로 두 플랫폼 다 안전하게 처리한다.
    const data = notification.data as { link?: string; title?: string; body?: string } | undefined;
    const title = notification.title ?? data?.title ?? "";
    const body = notification.body ?? data?.body ?? "";
    const link = data?.link;
    showForegroundPushBanner(title, body, () => {
      if (typeof link === "string") onNavigate(link);
    });
  });
}
