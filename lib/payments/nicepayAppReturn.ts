/*
  NICEPAY v3 앱(WebView) 결제 복귀 — 서버·웹·네이티브가 같은 규칙을 쓰도록 모은 순수 모듈(네트워크·환경변수 없음).
  공식 문서(developers.nicepay.co.kr/docs/pg/auth/payment-window, /docs/pg/add/app-webview, 2026-10-30 열람):
    · WapUrl        : 제휴사(카드사) 앱 인증 후 가맹점 앱으로 돌아오기 위한 "가맹점 App Scheme"(500 byte). 예시는 `nicepaysample://`. WebView 결제 시 추가.
    · IspCancelUrl  : ISP 인증 취소 시 앱으로 돌아오기 위한 스킴 URL(500 byte).
    · 값의 정확한 형식·허용 규칙은 문서에 더 없다 → 아래 URL 형식(`<scheme>://nicepay/wap|cancel?orderId=<uuid>`)과 scheme 이름은 "제안값(미확정)"이다.
      NICEPAY 기술지원 확인 + 사용자 승인 전에는 서버 설정(NICEPAY_APP_RETURN_ENABLED/…_SCHEME)이 꺼져 있어 WapUrl/IspCancelUrl 이 어디에도 실리지 않는다(fail-closed).
  보안 원칙: ① 복귀 URL 에는 주문 UUID 외에 아무 비밀(복귀 토큰·세션)도 싣지 않는다(같은 scheme 을 등록한 다른 앱이 가로챌 수 있다고 가정). ② 복귀 URL 이 들어왔다는 사실은 결제 성공이 아니다 —
  결과 화면이 서버(DB 주문 상태)를 다시 묻는다. ③ 클라이언트는 URL 을 정하지 못한다(서버 설정의 scheme 으로만 만든다).
*/
import allowlist from "./nicepayAppAllowlist.json";

/** 제안 scheme(미확정 — 사용자 승인 + NICEPAY 확인 전까지 운영 설정에 넣지 않는다). iOS Info.plist·Android Manifest 의 값과 일치해야 한다(테스트가 고정). */
export const NICEPAY_APP_RETURN_PROPOSED_SCHEME = "mwhabitnicepay";
export const NICEPAY_APP_RETURN_HOST = "nicepay";
export const NICEPAY_APP_RETURN_PATH = { wap: "/wap", cancel: "/cancel" } as const;
const MAX_BYTES = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// 다른 용도(웹·OS·로그인·결제 앱)와 겹치면 안 되는 scheme.
const RESERVED = new Set(["http", "https", "ftp", "file", "data", "blob", "about", "javascript", "intent", "market", "tel", "sms", "mailto", "itms", "itms-apps", "itms-services", "capacitor", "ionic", "kakaotalk", "naversearchthirdlogin", "supertoss", "payco", "nicepaysample", ...allowlist.iosSchemes, ...allowlist.neverHandleSchemes]);

export function isValidAppReturnScheme(s: unknown): s is string {
  if (typeof s !== "string" || !/^[a-z][a-z0-9+.-]{5,31}$/.test(s)) return false;   // 소문자 시작, 6~32자, scheme 문자만
  if (RESERVED.has(s) || s.startsWith("com.googleusercontent.apps") || s.startsWith("kakao") || s.startsWith("fb") || s.startsWith("nicepay")) return false;
  return true;
}

export type AppClient = "ios" | "android";
export const parseAppClient = (v: unknown): AppClient | null => (v === "ios" || v === "android" ? v : null);

/** WapUrl / IspCancelUrl — scheme 은 서버 설정 값, orderId 는 DB 주문 UUID 다(클라이언트 입력 불가). 형식 불일치면 null. */
export function buildAppReturnUrls(scheme: string, orderId: string): { WapUrl: string; IspCancelUrl: string } | null {
  if (!isValidAppReturnScheme(scheme) || !UUID.test(orderId)) return null;
  const base = `${scheme}://${NICEPAY_APP_RETURN_HOST}`;
  const out = { WapUrl: `${base}${NICEPAY_APP_RETURN_PATH.wap}?orderId=${orderId}`, IspCancelUrl: `${base}${NICEPAY_APP_RETURN_PATH.cancel}?orderId=${orderId}` };
  return new TextEncoder().encode(out.WapUrl).length <= MAX_BYTES && new TextEncoder().encode(out.IspCancelUrl).length <= MAX_BYTES ? out : null;
}

export type AppReturn = { kind: "wap" | "cancel"; orderId: string };
/**
 * 들어온 복귀 URL 검증 — 네이티브(iOS Swift·Android Java)가 같은 규칙을 구현한다(테스트가 소스 문자열로 동일성을 고정).
 * 정확히 `<scheme>://nicepay/(wap|cancel)?orderId=<소문자 uuid>` 만 통과: 다른 호스트·경로·추가 쿼리·fragment·userinfo·포트·대문자 UUID 는 모두 거부.
 */
export function parseAppReturnUrl(raw: unknown, scheme: string): AppReturn | null {
  if (typeof raw !== "string" || raw.length > MAX_BYTES || !isValidAppReturnScheme(scheme)) return null;
  const m = /^([a-z][a-z0-9+.-]*):\/\/([^/?#:@]*)(\/[^?#]*)?(\?[^#]*)?(#.*)?$/.exec(raw);
  if (!m || m[1] !== scheme || m[2] !== NICEPAY_APP_RETURN_HOST || m[5]) return null;
  const kind = m[3] === NICEPAY_APP_RETURN_PATH.wap ? "wap" : m[3] === NICEPAY_APP_RETURN_PATH.cancel ? "cancel" : null;
  const q = /^\?orderId=([0-9a-f-]+)$/.exec(m[4] ?? "");
  if (!kind || !q || !UUID.test(q[1])) return null;
  return { kind, orderId: q[1] };
}

/** 복귀 후 WebView 가 열 결과 화면 경로(상대). 앱 복귀는 rt 없이 로그인 세션으로 상태를 묻는다(app=1). cancel 은 결과 화면이 주문 정리를 요청한다. */
export const appReturnResultPath = (r: AppReturn): string => `/checkout/nicepay/result?orderId=${r.orderId}&app=1${r.kind === "cancel" ? "&cancel=1" : ""}`;

/** 결제 중 WebView 가 이미 NICEPAY/결제 화면에 있으면 wap 복귀에서 화면을 바꾸지 않는다(진행 중인 인증→ReturnURL 승인 흐름을 끊지 않는다). 콜드 스타트(앱 재시작)·다른 화면이면 결과 화면으로 간다. */
export function shouldNavigateOnReturn(kind: AppReturn["kind"], currentUrl: string | null, appHost: string): boolean {
  if (kind === "cancel") return true;   // ISP 취소는 NICEPAY 가 ReturnURL 로 이어가지 않으므로 결과 화면(주문 정리)으로 간다
  if (!currentUrl) return true;
  try { const u = new URL(currentUrl); return !(isNicepayHost(u.hostname) || (u.hostname === appHost && u.pathname.startsWith("/checkout"))); } catch { return true; }
}
export const isNicepayHost = (h: string) => h === "nicepay.co.kr" || h.endsWith(".nicepay.co.kr");

export const NICEPAY_IOS_SCHEMES: readonly string[] = allowlist.iosSchemes;
export const NICEPAY_ANDROID_PACKAGES: readonly string[] = allowlist.androidPackages;
export const NICEPAY_ISP_APPSTORE_ID: string = allowlist.iosIspAppStoreId;
export const NICEPAY_NEVER_HANDLE_SCHEMES: readonly string[] = allowlist.neverHandleSchemes;
