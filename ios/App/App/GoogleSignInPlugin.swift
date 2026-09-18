import Foundation
import UIKit
import Capacitor
import GoogleSignIn

/*
  iOS 전용 — Google Sign In 네이티브 플로우(GIDSignIn, GoogleSignIn-iOS SDK).

  실기기 QA(2026-09-15) — 기존 signInWithOAuth("google")는 이 앱의 server.url 모드
  WKWebView 안에서 accounts.google.com으로 직접 이동하는데, Google이 임베디드
  WebView에서의 OAuth를 "disallowed_useragent"로 서버 단에서 차단한다(Google 공식
  정책 — 일반 WKWebView는 승인된 브라우저로 안 침). 그 결과 정상 로그인 화면 대신
  이상한 페이지가 뜨고, 그 상태에서 뒤로 돌아오면 `socialLoading` 상태가 리셋될
  기회 자체가 없어(에러가 우리 코드로 reject되지 않고 구글 자체 페이지에서 끝남)
  구글/카카오/네이버/애플 버튼이 전부 영구적으로 비활성화되는 사고로 이어졌다.
  네이티브 Google Sign-In으로 전환하면 이 문제 자체가 구조적으로 사라진다(WebView
  네비게이션이 아예 없음).

  Apple(AppleSignInPlugin.swift)과 동일한 선례를 따라 이 앱 전용 로컬 커스텀
  플러그인으로 구현하되, Google은 Apple과 달리 순수 Foundation API가 아니라 실제
  SDK(GoogleSignIn-iOS, project.pbxproj에 Swift Package로 직접 추가함 — Firebase와
  동일한 방식, XCRemoteSwiftPackageReference 참고)가 필요하다. 처음엔 여러 provider를
  한 번에 지원하는 서드파티 Capacitor 플러그인(@capgo/capacitor-social-login)도
  검토했으나, 그 패키지는 Google 하나만 써도 Facebook SDK + Alamofire까지 통째로
  끌려들어와(자체 Package.swift 확인함) 이 앱이 전혀 쓰지 않는 Facebook 로그인용
  Info.plist 설정이 없으면 앱 시작 시 SDK 초기화 문제가 생길 위험이 있어 제외했다.

  Client ID는 이 파일에 하드코딩하지 않는다 — JS 쪽(lib/googleAuth.ts)이
  NEXT_PUBLIC_GOOGLE_IOS_CLIENT_ID 환경변수 값을 런타임에 넘겨준다(카카오/네이버의
  NEXT_PUBLIC_KAKAO_CLIENT_ID 등과 동일한 기존 관례 재사용, 새 설정 방식 도입 안 함).
*/
@objc(GoogleSignInPlugin)
public class GoogleSignInPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "GoogleSignInPlugin"
    public let jsName = "GoogleSignIn"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "authorize", returnType: CAPPluginReturnPromise)
    ]

    // GoogleSignIn SDK의 공식 취소 에러 코드(kGIDSignInErrorCodeCanceled = -5,
    // GoogleSignIn-iOS의 GIDSignInError.h에 정의) — Swift enum 바인딩이 SDK 버전마다
    // 달라질 수 있어 안정적인 NSError domain/code 비교로 확인한다.
    private static let googleSignInErrorDomain = "com.google.GIDSignIn"
    private static let cancelledErrorCode = -5

    @objc func authorize(_ call: CAPPluginCall) {
        guard let clientId = call.getString("clientId"), !clientId.isEmpty else {
            call.reject("clientId가 필요해요")
            return
        }
        guard let hashedNonce = call.getString("hashedNonce"), !hashedNonce.isEmpty else {
            call.reject("hashedNonce가 필요해요")
            return
        }

        DispatchQueue.main.async {
            guard let presentingVc = UIApplication.shared.connectedScenes
                .compactMap({ ($0 as? UIWindowScene)?.keyWindow })
                .first?.rootViewController else {
                call.reject("로그인 화면을 표시할 창을 찾지 못했어요")
                return
            }

            GIDSignIn.sharedInstance.configuration = GIDConfiguration(clientID: clientId)
            GIDSignIn.sharedInstance.signIn(
                withPresenting: presentingVc,
                hint: nil,
                additionalScopes: [],
                nonce: hashedNonce
            ) { result, error in
                if let error = error {
                    let nsError = error as NSError
                    if nsError.domain == Self.googleSignInErrorDomain && nsError.code == Self.cancelledErrorCode {
                        call.reject("canceled", "canceled", error)
                        return
                    }
                    call.reject(error.localizedDescription, "failed", error)
                    return
                }
                guard let idToken = result?.user.idToken?.tokenString else {
                    call.reject("Google 로그인 응답에서 idToken을 읽지 못했어요")
                    return
                }
                var data: [String: Any] = ["idToken": idToken]
                if let email = result?.user.profile?.email { data["email"] = email }
                if let name = result?.user.profile?.name { data["fullName"] = name }
                call.resolve(data)
            }
        }
    }
}
