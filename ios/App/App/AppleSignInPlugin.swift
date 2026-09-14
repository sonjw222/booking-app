import Foundation
import UIKit
import Capacitor
import AuthenticationServices

/*
  iOS 전용 — Sign in with Apple 네이티브 플로우(ASAuthorizationAppleIDProvider).

  릴리스 폴리시 배치(2026-09-14) 사용자 결정: 기존엔 다른 3개 provider(구글/카카오/네이버)와
  같은 signInWithOAuth() 웹 리다이렉트 경로를 쓰려 했으나, 실제로 콘솔에 설정된 값
  (Supabase Apple Provider의 Client IDs = 앱 Bundle ID, Secret Key = 비어 있음)이 OAuth
  플로우가 아니라 네이티브 플로우 설정과 정확히 일치한다(Supabase 공식 문서: OAuth 플로우는
  별도 Services ID + .p8 기반 서명 JWT가 반드시 필요 — 지금 설정으로는 signInWithOAuth가
  실패한다). 그래서 네이티브로 전환 — Services ID/6개월마다 시크릿 재발급이 아예 필요 없어짐.

  npm 서드파티 플러그인(@capgo/capacitor-social-login 등) 대신 이 파일처럼 이 앱 전용
  로컬 커스텀 플러그인으로 구현한다 — FcmTokenPlugin.swift와 동일한 선례(신규 의존성 없이
  최소 코드로 네이티브 API를 직접 감쌈)를 그대로 따른다.

  JS 쪽 소비: lib/appleAuth.ts가 @capacitor/core의 registerPlugin("AppleSignIn")으로 이
  플러그인을 사용. nonce는 반드시 JS 쪽이 원본(raw)을 만들고 SHA-256 해시만 이 플러그인에
  넘긴다 — Apple 요청엔 해시된 nonce를, 이후 Supabase signInWithIdToken()엔 원본 nonce를
  보내야 하는 Apple/Supabase 공식 요구사항 때문(원본을 네이티브가 만들면 JS가 알 방법이
  없어져 Supabase 호출에 못 씀).
*/
@objc(AppleSignInPlugin)
public class AppleSignInPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AppleSignInPlugin"
    public let jsName = "AppleSignIn"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "authorize", returnType: CAPPluginReturnPromise)
    ]

    // ASAuthorizationControllerDelegate는 콜백이 올 때까지 강하게 붙잡아둬야 한다 —
    // 지역 변수로만 두면 authorize() 리턴 직후 ARC가 회수해버려 콜백이 안 온다.
    private var currentDelegate: AppleSignInDelegate?

    @objc func authorize(_ call: CAPPluginCall) {
        guard let hashedNonce = call.getString("hashedNonce"), !hashedNonce.isEmpty else {
            call.reject("hashedNonce가 필요해요")
            return
        }
        let provider = ASAuthorizationAppleIDProvider()
        let request = provider.createRequest()
        request.requestedScopes = [.fullName, .email]
        request.nonce = hashedNonce

        let controller = ASAuthorizationController(authorizationRequests: [request])
        let delegate = AppleSignInDelegate(call: call) { [weak self] in
            self?.currentDelegate = nil
        }
        currentDelegate = delegate
        controller.delegate = delegate
        controller.presentationContextProvider = delegate
        controller.performRequests()
    }
}

private class AppleSignInDelegate: NSObject, ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding {
    private let call: CAPPluginCall
    private let onFinished: () -> Void

    init(call: CAPPluginCall, onFinished: @escaping () -> Void) {
        self.call = call
        self.onFinished = onFinished
    }

    func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        UIApplication.shared.connectedScenes
            .compactMap { ($0 as? UIWindowScene)?.keyWindow }
            .first ?? ASPresentationAnchor()
    }

    func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization) {
        defer { onFinished() }
        guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
              let tokenData = credential.identityToken,
              let identityToken = String(data: tokenData, encoding: .utf8) else {
            call.reject("Apple 로그인 응답에서 identityToken을 읽지 못했어요")
            return
        }
        var result: [String: Any] = ["identityToken": identityToken]
        // 애플은 "최초 인증"에서만 이름을 준다(이후 로그인엔 항상 nil) — 있을 때만 실어
        // 보낸다. lib/appleAuth.ts가 이 값을 세션스토리지에 잠깐 저장해뒀다가
        // lib/authAccount.ts의 ensureAccountForCurrentUser()가 계정을 처음 만들 때
        // 이름으로 쓴다(user_metadata에는 애초에 안 실려서 나중에 다시 읽을 방법이 없음).
        if let fullName = credential.fullName {
            let formatted = PersonNameComponentsFormatter().string(from: fullName)
            if !formatted.isEmpty { result["fullName"] = formatted }
        }
        if let email = credential.email {
            result["email"] = email
        }
        call.resolve(result)
    }

    func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        defer { onFinished() }
        if let authError = error as? ASAuthorizationError, authError.code == .canceled {
            call.reject("canceled", "canceled", error)
            return
        }
        call.reject(error.localizedDescription, "failed", error)
    }
}
