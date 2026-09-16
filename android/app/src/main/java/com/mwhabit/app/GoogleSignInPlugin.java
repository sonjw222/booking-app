package com.mwhabit.app;

import androidx.annotation.NonNull;
import androidx.core.content.ContextCompat;
import androidx.credentials.Credential;
import androidx.credentials.CredentialManager;
import androidx.credentials.CredentialManagerCallback;
import androidx.credentials.CustomCredential;
import androidx.credentials.GetCredentialRequest;
import androidx.credentials.GetCredentialResponse;
import androidx.credentials.exceptions.GetCredentialCancellationException;
import androidx.credentials.exceptions.GetCredentialException;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.libraries.identity.googleid.GetSignInWithGoogleOption;
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential;
import com.google.android.libraries.identity.googleid.GoogleIdTokenParsingException;

/**
 * Android 전용 — Google Sign In 네이티브 플로우(androidx.credentials Credential Manager,
 * Google 공식 최신 권장 API — 예전 play-services-auth의 GoogleSignInClient는 deprecated).
 *
 * 실기기 QA(2026-09-15) — 기존 signInWithOAuth("google")는 이 앱의 server.url 모드
 * WebView 안에서 accounts.google.com으로 직접 이동하는데, Google이 임베디드 WebView에서의
 * OAuth를 "disallowed_useragent"로 서버 단에서 차단한다(일반 WebView는 승인된 브라우저가
 * 아님). 네이티브 Google Sign-In으로 전환하면 이 문제 자체가 구조적으로 사라진다(WebView
 * 네비게이션이 아예 없음). iOS(GoogleSignInPlugin.swift, GoogleSignIn-iOS SDK)와 정확히
 * 같은 jsName("GoogleSignIn")·authorize(clientId, hashedNonce) 계약을 공유해
 * lib/googleAuth.ts가 플랫폼 분기 없이 동일한 코드로 두 플랫폼을 모두 호출한다.
 *
 * nonce 처리 — JS(lib/googleAuth.ts)가 원본(raw) nonce를 만들고 SHA-256 해시만 이
 * 플러그인에 hashedNonce로 넘긴다(iOS와 동일 관례). 원본은 JS가 이후
 * supabase.auth.signInWithIdToken()에 직접 보낸다.
 *
 * clientId는 JS 쪽 NEXT_PUBLIC_GOOGLE_WEB_CLIENT_ID 환경변수 값이 런타임에 넘어온다 —
 * Android의 Credential Manager 네이티브 플로우는 Web Client ID를 serverClientId(=이
 * 자격증명의 검증 대상 audience)로 사용한다(Supabase/Google 공식 문서 — Android 네이티브
 * 앱 전용 Android Client ID가 따로 필요하지 않음, 패키지명+SHA-1 핑거프린트만 Google
 * Cloud Console에 등록하면 됨).
 */
@CapacitorPlugin(name = "GoogleSignIn")
public class GoogleSignInPlugin extends Plugin {

    @PluginMethod
    public void authorize(PluginCall call) {
        String clientId = call.getString("clientId");
        String hashedNonce = call.getString("hashedNonce");
        if (clientId == null || clientId.isEmpty()) {
            call.reject("clientId가 필요해요");
            return;
        }
        if (hashedNonce == null || hashedNonce.isEmpty()) {
            call.reject("hashedNonce가 필요해요");
            return;
        }

        GetSignInWithGoogleOption option = new GetSignInWithGoogleOption.Builder(clientId)
                .setNonce(hashedNonce)
                .build();
        GetCredentialRequest request = new GetCredentialRequest.Builder()
                .addCredentialOption(option)
                .build();

        CredentialManager credentialManager = CredentialManager.create(getContext());
        credentialManager.getCredentialAsync(
                getActivity(),
                request,
                null,
                ContextCompat.getMainExecutor(getContext()),
                new CredentialManagerCallback<GetCredentialResponse, GetCredentialException>() {
                    @Override
                    public void onResult(@NonNull GetCredentialResponse result) {
                        handleResult(call, result);
                    }

                    @Override
                    public void onError(@NonNull GetCredentialException e) {
                        if (e instanceof GetCredentialCancellationException) {
                            call.reject("canceled", "canceled", e);
                            return;
                        }
                        call.reject(e.getMessage(), "failed", e);
                    }
                }
        );
    }

    private void handleResult(PluginCall call, GetCredentialResponse result) {
        Credential credential = result.getCredential();
        if (!(credential instanceof CustomCredential)) {
            call.reject("Google 로그인 응답에서 필요한 정보를 받지 못했어요");
            return;
        }
        CustomCredential customCredential = (CustomCredential) credential;
        if (!GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL.equals(customCredential.getType())) {
            call.reject("Google 로그인 응답에서 필요한 정보를 받지 못했어요");
            return;
        }
        // googleid 1.2.0의 GoogleIdTokenCredential.createFrom()은 Kotlin으로 컴파일돼
        // javac가 checked exception(GoogleIdTokenParsingException) 선언을 인식하지
        // 못한다(catch (GoogleIdTokenParsingException e)로 잡으면 "never thrown in body"
        // 컴파일 에러) — 실제로 JVM 레벨에서는 여전히 던져질 수 있으므로(Kotlin은 checked
        // exception을 강제하지 않을 뿐 인스턴스 자체는 그대로 던짐) 상위 타입인
        // Exception으로 안전하게 받는다.
        try {
            GoogleIdTokenCredential googleIdTokenCredential =
                    GoogleIdTokenCredential.createFrom(customCredential.getData());
            JSObject data = new JSObject();
            data.put("idToken", googleIdTokenCredential.getIdToken());
            if (googleIdTokenCredential.getDisplayName() != null) {
                data.put("fullName", googleIdTokenCredential.getDisplayName());
            }
            if (googleIdTokenCredential.getEmail() != null) {
                data.put("email", googleIdTokenCredential.getEmail());
            }
            call.resolve(data);
        } catch (Exception e) {
            call.reject("Google 로그인 응답을 읽지 못했어요", "failed", e);
        }
    }
}
