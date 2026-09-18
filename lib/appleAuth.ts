/*
  Apple 네이티브 로그인(Sign in with Apple) 시작.

  릴리스 폴리시 배치(2026-09-14) — 원래 다른 3개 provider(구글/카카오/네이버)처럼
  signInWithOAuth()를 쓰려 했으나, 실제 콘솔 설정(Supabase Apple Provider: Client IDs =
  앱 Bundle ID `com.mwhabit.app`, Secret Key 비어 있음)이 OAuth 플로우가 아니라 **네이티브
  플로우** 설정과 일치한다 — Supabase 공식 문서: OAuth 플로우는 별도 Services ID + .p8로
  서명한 JWT 시크릿이 반드시 필요하고, 지금 상태로 signInWithOAuth를 부르면 토큰 교환이
  실패한다. 그래서 네이티브(ASAuthorizationAppleIDProvider, ios/App/App/AppleSignInPlugin.swift)
  → supabase.auth.signInWithIdToken()로 전환 — Services ID/6개월마다 시크릿 재발급이
  아예 필요 없어진다(Supabase 공식 문서: "Native-only implementations don't require
  secret key rotation").

  nonce 처리(Apple/Supabase 공식 요구사항) — 원본(raw) nonce는 반드시 이 JS 쪽에서 만들고,
  Apple 인증 요청에는 SHA-256 **해시**만 보낸다(네이티브 플러그인에 hashedNonce로 전달).
  Apple이 돌려주는 identityToken은 그 해시를 담고 있고, Supabase signInWithIdToken()에는
  **원본** nonce를 보내야 검증이 된다 — 원본을 네이티브가 만들면 JS가 그 값을 모르게 되므로
  반드시 JS가 원본의 주인이어야 한다.

  네이티브 전용(iOS) — Capacitor.isNativePlatform()이 false거나 플랫폼이 iOS가 아니면
  (웹 브라우저, Android) 아예 시도하지 않고 에러를 던진다 — 이 Supabase 설정으로는 웹 OAuth
  경로가 어차피 동작하지 않고, ASAuthorizationAppleIDProvider 자체가 iOS/macOS 네이티브
  API라 웹에는 대응하는 게 없다. app/login/page.tsx가 이 에러를 다른 미설정 provider와
  동일한 패턴(버튼은 보이되 누르면 안내 메시지, 앱이 죽지 않음)으로 처리한다.
*/

import { Capacitor, registerPlugin } from "@capacitor/core";
import { supabase } from "./supabaseClient";
import { stashAppleFullName } from "./authAccount";

interface AppleSignInNativePlugin {
  authorize(options: { hashedNonce: string }): Promise<{
    identityToken: string;
    fullName?: string;
    email?: string;
  }>;
}

// ios/App/App/AppleSignInPlugin.swift — npm 패키지가 아닌 이 앱 전용 로컬 커스텀
// 플러그인(FcmTokenPlugin과 동일한 선례)이라 registerPlugin으로 직접 연결한다.
const AppleSignInNative = registerPlugin<AppleSignInNativePlugin>("AppleSignIn");

export function isAppleNativeSignInSupported(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === "ios";
}

// Apple 로그인은 일반 웹에서는 OAuth로 제공하고, iOS 앱에서는 위 네이티브 플러그인을
// 사용한다. 대응 가능한 Apple 인증 수단이 없는 Android 네이티브 앱에서만 버튼을 숨긴다.
export function shouldShowAppleSignInButton(): boolean {
  return !(Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android");
}

export class AppleSignInCancelledError extends Error {}

// export해서 단위 테스트로 알려진 SHA-256 테스트 벡터와 대조 검증한다 — 이 해시가 틀리면
// Apple에 보낸 해시 nonce와 나중에 Supabase에 보낼 원본 nonce가 서로 안 맞아
// signInWithIdToken() 검증이 항상 실패하는데, 그 실패가 이 함수 버그 때문인지 다른
// 원인인지 구분하기 어렵다 — 여기서 미리 잡는다.
export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function isCancelledError(e: any): boolean {
  return e?.code === "canceled" || e?.message === "canceled";
}

// Capacitor의 registerPlugin() 프록시는 네이티브 쪽에 해당 플러그인이 실제로 등록돼
// 있지 않으면(빌드에 Swift 파일이 안 실렸거나, project.pbxproj 등록 누락 등) 메서드
// 호출 시 "\"AppleSignIn.authorize()\" is not implemented on ios" 형태의
// CapacitorException(ExceptionCode.Unimplemented)을 던진다 — 이 신호를 명시적으로
//구분해서, 정책대로 signInWithOAuth 등 어떤 웹 폴백도 시도하지 않고 여기서 바로
// 끝낸다(실기기 QA 2026-09-14: 정책 — "네이티브 플러그인을 못 찾았다고 OAuth로
// 폴백하지 말 것, 앱 내부 오류로 끝낼 것").
export function isPluginUnavailableError(e: any): boolean {
  const msg = String(e?.message ?? "");
  return e?.code === "UNIMPLEMENTED" || /not implemented/i.test(msg);
}

// 성공하면 세션이 생긴다(SessionWatcher의 onAuthStateChange가 계정 부트스트랩을 이어서
// 처리 — app/login/page.tsx의 다른 provider와 동일). 애플이 최초 인증에서만 내려주는
// fullName은 signInWithIdToken() 호출 "전"에 미리 세션스토리지에 스태시해둔다 — 세션이
// 생기는 순간 SessionWatcher의 SIGNED_IN 핸들러가 언제 돌지 보장이 안 돼서(비동기 레이스),
// 세션이 생기기도 전에 미리 저장해둬야 ensureAccountForCurrentUser()가 계정을 만드는
// 시점에 항상 이미 그 자리에 있다고 보장할 수 있다.
//
// 실기기 QA(2026-09-14) — 실기기에서 어느 코드 경로가 실제로 실행되는지 추적할 수 있게
// 각 단계에 console.log를 남긴다(Xcode 콘솔/Safari 원격 디버거로 확인 가능). 이 함수는
// 절대 supabase.auth.signInWithOAuth를 호출하지 않는다 — 실패는 전부 이 함수 안에서
// Error를 던지는 것으로 끝난다(app/login/page.tsx가 메시지만 보여주고 아무 곳으로도
// 이동하지 않음).
export async function signInWithAppleNative(): Promise<{ fullName?: string }> {
  console.log("[appleAuth] signInWithAppleNative 시작", {
    isNativePlatform: Capacitor.isNativePlatform(),
    platform: Capacitor.getPlatform(),
  });
  if (!isAppleNativeSignInSupported()) {
    console.log("[appleAuth] 네이티브 iOS 플랫폼이 아님 — 중단");
    throw new Error("Apple 로그인은 현재 iOS 앱에서만 지원돼요");
  }

  // UUID 두 개를 이어붙여 Apple/Supabase 권장 nonce 최소 길이(32자 이상)를 넉넉히 확보.
  const rawNonce = crypto.randomUUID() + crypto.randomUUID();
  const hashedNonce = await sha256Hex(rawNonce);

  let native: { identityToken: string; fullName?: string; email?: string };
  try {
    console.log("[appleAuth] AppleSignIn.authorize() 네이티브 플러그인 호출");
    native = await AppleSignInNative.authorize({ hashedNonce });
    console.log("[appleAuth] 네이티브 플러그인 응답 수신", {
      hasIdentityToken: !!native?.identityToken,
      hasFullName: !!native?.fullName,
    });
  } catch (e: any) {
    if (isCancelledError(e)) {
      console.log("[appleAuth] 사용자가 Apple 인증 시트에서 취소함");
      throw new AppleSignInCancelledError("사용자가 취소했어요");
    }
    if (isPluginUnavailableError(e)) {
      console.error("[appleAuth] AppleSignIn 네이티브 플러그인을 찾을 수 없음 — OAuth로 폴백하지 않고 종료", e);
      throw new Error("Apple 로그인을 초기화할 수 없어요. 앱을 최신 버전으로 업데이트해주세요.");
    }
    console.error("[appleAuth] 네이티브 플러그인 호출 실패", e);
    throw new Error(e?.message || "Apple 로그인에 실패했어요");
  }
  if (!native?.identityToken) {
    console.error("[appleAuth] identityToken 누락된 응답", native);
    throw new Error("Apple 로그인 응답에서 필요한 정보를 받지 못했어요");
  }
  if (native.fullName) stashAppleFullName(native.fullName);

  console.log("[appleAuth] supabase.auth.signInWithIdToken() 호출");
  const { error } = await supabase.auth.signInWithIdToken({
    provider: "apple",
    token: native.identityToken,
    nonce: rawNonce,
  });
  if (error) {
    console.error("[appleAuth] signInWithIdToken 실패", error);
    throw new Error(error.message);
  }

  console.log("[appleAuth] 로그인 성공");
  return { fullName: native.fullName };
}
