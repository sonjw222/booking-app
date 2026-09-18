/*
  Google 네이티브 로그인(Native Google Sign-In) 시작.

  릴리스 폴리시 배치(2026-09-15, release blocker) — 실기기 QA에서 구글 로그인이
  완전히 깨져 있음이 확인됐다: 기존 signInWithOAuth("google")는 이 앱의 server.url
  모드 WKWebView 안에서 accounts.google.com으로 직접 이동하는데, Google이 임베디드
  WebView에서의 OAuth를 "disallowed_useragent" 정책으로 서버 단에서 차단한다(일반
  WKWebView는 Google이 승인한 브라우저가 아님). 그 결과 정상 로그인 화면 대신 이상한
  웹 페이지가 뜨고 앱 안에서 로그인이 끝나지 않으며, 그 상태에서 뒤로 돌아오면 에러가
  우리 코드로 reject되지 않고 구글 자체 페이지에서 끝나 `socialLoading` 상태가 리셋될
  기회가 없어 구글/카카오/네이버/애플 버튼이 전부 영구적으로 비활성화되는 사고로
  이어졌다. Apple과 동일한 패턴(네이티브 SDK → ID 토큰 → supabase.auth.signInWithIdToken)
  으로 전환하면 이 문제 자체가 구조적으로 사라진다(WebView 네비게이션이 아예 없음).

  Apple과의 차이 — Apple은 iOS 전용이지만 Google 네이티브 SDK는 iOS/Android 둘 다
  있어 isGoogleNativeSignInSupported()는 두 플랫폼 모두에서 true를 반환한다. 순수 웹
  브라우저(네이티브 앱이 아닌 경우)는 기존 signInWithOAuth 경로를 그대로 유지한다 —
  이 파일은 네이티브 전용이고, app/login/page.tsx가 플랫폼에 따라 분기한다.

  nonce 처리(Google/Supabase 공식 요구사항, Apple과 동일 패턴) — 원본(raw) nonce는
  반드시 이 JS 쪽에서 만들고, 네이티브 Google 인증 요청에는 SHA-256 **해시**만
  보낸다(네이티브 플러그인에 hashedNonce로 전달). Supabase signInWithIdToken()에는
  **원본** nonce를 보내야 검증이 된다.

  Client ID — 카카오/네이버의 NEXT_PUBLIC_KAKAO_CLIENT_ID 등과 동일한 기존 관례를
  재사용한다(새 설정 방식 도입 안 함): NEXT_PUBLIC_GOOGLE_IOS_CLIENT_ID(iOS),
  NEXT_PUBLIC_GOOGLE_WEB_CLIENT_ID(Android — Credential Manager는 서버 검증용으로
  Web Client ID를 audience로 쓴다, Supabase 공식 문서). 아직 설정 전이면 다른
  미설정 provider와 동일하게 "구글 로그인 설정이 아직 안 되어 있어요" 안내만 하고
  앱이 죽지 않는다.
*/

import { Capacitor, registerPlugin } from "@capacitor/core";
import { supabase } from "./supabaseClient";
import { sha256Hex } from "./appleAuth";

interface GoogleSignInNativePlugin {
  authorize(options: { clientId: string; hashedNonce: string }): Promise<{
    idToken: string;
    fullName?: string;
    email?: string;
  }>;
}

// ios/App/App/GoogleSignInPlugin.swift — npm 패키지가 아닌 이 앱 전용 로컬 커스텀
// 플러그인(AppleSignInPlugin과 동일한 선례)이라 registerPlugin으로 직접 연결한다.
// Android 쪽 네이티브 구현이 추가되면 같은 jsName("GoogleSignIn")으로 등록된다.
const GoogleSignInNative = registerPlugin<GoogleSignInNativePlugin>("GoogleSignIn");

export function isGoogleNativeSignInSupported(): boolean {
  return Capacitor.isNativePlatform();
}

export class GoogleSignInCancelledError extends Error {}

export class GoogleSignInNotConfiguredError extends Error {}

function isCancelledError(e: any): boolean {
  return e?.code === "canceled" || e?.message === "canceled";
}

// registerPlugin() 프록시는 네이티브 쪽에 해당 플러그인이 실제로 등록돼 있지 않으면
// (빌드에 네이티브 파일이 안 실렸거나 등록 누락 등) 메서드 호출 시
// CapacitorException(ExceptionCode.Unimplemented)을 던진다 — appleAuth.ts와 동일한
// 판별 로직. export해서 단위 테스트로 고정한다(appleAuth.isPluginUnavailableError와 동일 관례).
export function isPluginUnavailableError(e: any): boolean {
  const msg = String(e?.message ?? "");
  return e?.code === "UNIMPLEMENTED" || /not implemented/i.test(msg);
}

function getClientId(): string {
  const platform = Capacitor.getPlatform();
  const clientId =
    platform === "ios"
      ? process.env.NEXT_PUBLIC_GOOGLE_IOS_CLIENT_ID
      : process.env.NEXT_PUBLIC_GOOGLE_WEB_CLIENT_ID;
  if (!clientId) {
    throw new GoogleSignInNotConfiguredError("구글 로그인 설정이 아직 안 되어 있어요");
  }
  return clientId;
}

// 성공하면 세션이 생긴다(SessionWatcher의 onAuthStateChange가 계정 부트스트랩을 이어서
// 처리 — app/login/page.tsx의 다른 provider와 동일 패턴).
export async function signInWithGoogleNative(): Promise<{ fullName?: string }> {
  console.log("[googleAuth] signInWithGoogleNative 시작", {
    isNativePlatform: Capacitor.isNativePlatform(),
    platform: Capacitor.getPlatform(),
  });
  if (!isGoogleNativeSignInSupported()) {
    console.log("[googleAuth] 네이티브 플랫폼이 아님 — 중단");
    throw new Error("네이티브 Google 로그인은 앱에서만 지원돼요");
  }

  const clientId = getClientId();

  // UUID 두 개를 이어붙여 권장 nonce 최소 길이를 넉넉히 확보(Apple과 동일 관례).
  const rawNonce = crypto.randomUUID() + crypto.randomUUID();
  const hashedNonce = await sha256Hex(rawNonce);

  let native: { idToken: string; fullName?: string; email?: string };
  try {
    console.log("[googleAuth] GoogleSignIn.authorize() 네이티브 플러그인 호출");
    native = await GoogleSignInNative.authorize({ clientId, hashedNonce });
    console.log("[googleAuth] 네이티브 플러그인 응답 수신", {
      hasIdToken: !!native?.idToken,
      hasFullName: !!native?.fullName,
    });
  } catch (e: any) {
    if (isCancelledError(e)) {
      console.log("[googleAuth] 사용자가 Google 인증 화면에서 취소함");
      throw new GoogleSignInCancelledError("사용자가 취소했어요");
    }
    if (isPluginUnavailableError(e)) {
      console.error("[googleAuth] GoogleSignIn 네이티브 플러그인을 찾을 수 없음 — OAuth로 폴백하지 않고 종료", e);
      throw new Error("Google 로그인을 초기화할 수 없어요. 앱을 최신 버전으로 업데이트해주세요.");
    }
    console.error("[googleAuth] 네이티브 플러그인 호출 실패", e);
    throw new Error(e?.message || "Google 로그인에 실패했어요");
  }
  if (!native?.idToken) {
    console.error("[googleAuth] idToken 누락된 응답", native);
    throw new Error("Google 로그인 응답에서 필요한 정보를 받지 못했어요");
  }

  console.log("[googleAuth] supabase.auth.signInWithIdToken() 호출");
  const { error } = await supabase.auth.signInWithIdToken({
    provider: "google",
    token: native.idToken,
    nonce: rawNonce,
  });
  if (error) {
    console.error("[googleAuth] signInWithIdToken 실패", error);
    throw new Error(error.message);
  }

  console.log("[googleAuth] 로그인 성공");
  return { fullName: native.fullName };
}
