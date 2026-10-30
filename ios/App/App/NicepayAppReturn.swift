import Foundation

/*
  NICEPAY v3 앱(WebView) 결제 복귀·카드사 앱 호출 — 순수 로직(UIKit/Capacitor 의존 없음, 단독 컴파일·검사 가능).
  lib/payments/nicepayAppReturn.ts 와 같은 규칙이다(tests/unit/nicepayNativeParity.test.ts 가 허용 목록·scheme·형식 동일성을 고정).
    · 복귀 URL 은 정확히 `<scheme>://nicepay/(wap|cancel)?orderId=<소문자 uuid>` 만 통과한다(다른 호스트·경로·추가 쿼리·fragment·userinfo·포트·대문자 UUID 거부).
    · 복귀 URL 이 왔다는 사실은 결제 성공이 아니다 — 결과 화면이 서버(DB 주문 상태)를 다시 묻는다. URL 에는 주문 UUID 외 비밀이 없다.
    · scheme 은 제안값(미확정): NICEPAY 기술지원 확인 + 사용자 승인 전에는 서버 설정이 꺼져 있어 WapUrl/IspCancelUrl 이 전송되지 않는다(이 앱 코드는 대기 상태).
  카드사 앱 scheme 허용 목록 출처: developers.nicepay.co.kr/docs/pg/add/app-webview(신용카드·공동인증 구분). kakaotalk·naversearchthirdlogin 등 소셜 로그인과 겹치는 scheme 은 일부러 제외했다.
*/
enum NicepayAppReturn {
    /// 제안 scheme(미확정). Info.plist CFBundleURLTypes 의 값과 같아야 한다.
    static let scheme = "mwhabitnicepay"
    static let host = "nicepay"
    static let ispAppStoreId = "369125087"

    /// 카드사 앱 iOS scheme 허용 목록(소문자). Info.plist LSApplicationQueriesSchemes 와 같은 목록.
    static let cardAppSchemes: Set<String> = [
        "mpocket.online.ansimclick",
        "scardcertiapp",
        "monimopay",
        "monimopayauth",
        "shinhan-sr-ansimclick",
        "smshinhanansimclick",
        "hdcardappcardansimclick",
        "smhyundaiansimclick",
        "kb-acp",
        "kbbank",
        "newliiv",
        "ispmobile",
        "cloudpay",
        "hanaskcardmobileportal",
        "hanawalletmembers",
        "lotteappcard",
        "lottesmartpay",
        "lpayapp",
        "lmslpay",
        "nhappcardansimclick",
        "nhallonepayansimclick",
        "nonghyupcardansimclick",
        "wooripay",
        "com.wooricard.wcard",
        "newsmartpib",
        "citispay",
        "citimobileapp",
        "kakaobank",
        "qhanamopmoasign"
    ]

    enum Kind { case wap, cancel }
    struct Parsed: Equatable { let kind: Kind; let orderId: String }

    private static let uuid = try! NSRegularExpression(pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")

    static func isValidOrderId(_ s: String) -> Bool {
        uuid.firstMatch(in: s, range: NSRange(location: 0, length: (s as NSString).length)) != nil
    }

    /// 복귀 URL 검증. 문자열 수준에서 엄격히 본다(URLComponents 의 관대한 정규화에 기대지 않는다).
    static func parse(_ raw: String) -> Parsed? {
        if raw.utf8.count > 500 { return nil }
        let prefix = "\(scheme)://\(host)"
        guard raw.hasPrefix(prefix + "/") else { return nil }
        let rest = String(raw.dropFirst(prefix.count))   // "/wap?orderId=..."
        if rest.contains("#") { return nil }
        let parts = rest.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)
        guard parts.count == 2 else { return nil }
        let kind: Kind
        switch parts[0] {
        case "/wap": kind = .wap
        case "/cancel": kind = .cancel
        default: return nil
        }
        let q = String(parts[1])
        guard q.hasPrefix("orderId=") else { return nil }
        let id = String(q.dropFirst("orderId=".count))
        guard isValidOrderId(id) else { return nil }
        return Parsed(kind: kind, orderId: id)
    }

    /// 열 결과 화면 경로(상대). 우리 서버의 결제 결과 화면만 — 외부 URL/토큰이 따라오지 않는다.
    static func resultPath(_ p: Parsed) -> String {
        "/checkout/nicepay/result?orderId=\(p.orderId)&app=1" + (p.kind == .cancel ? "&cancel=1" : "")
    }

    static func isNicepayHost(_ host: String?) -> Bool {
        guard let h = host?.lowercased() else { return false }
        return h == "nicepay.co.kr" || h.hasSuffix(".nicepay.co.kr")
    }

    /// 진행 중인 인증 흐름(NICEPAY·결제 화면)에서는 wap 복귀가 화면을 바꾸지 않는다(인증 → ReturnURL 승인 흐름을 끊지 않는다). 콜드 스타트·다른 화면이면 결과 화면으로. cancel 은 항상.
    static func shouldNavigate(kind: Kind, currentURL: URL?, appHost: String?) -> Bool {
        if kind == .cancel { return true }
        guard let u = currentURL, let h = u.host?.lowercased() else { return true }
        if isNicepayHost(h) { return false }
        if let app = appHost?.lowercased(), h == app, u.path.hasPrefix("/checkout") { return false }
        return true
    }

    /// 결제 문맥: 현재 WebView 가 NICEPAY 호스트이거나 앱의 /checkout 화면이다 — 이때만 허용 목록 밖 custom scheme 을 막는다(그 밖의 화면은 기존 Capacitor 동작 그대로 — 로그인 등 회귀 방지).
    static func isPaymentContext(currentURL: URL?, appHost: String?) -> Bool {
        guard let u = currentURL, let h = u.host?.lowercased() else { return false }
        if isNicepayHost(h) { return true }
        if let app = appHost?.lowercased(), h == app, u.path.hasPrefix("/checkout") { return true }
        return false
    }

    enum SchemeDecision: Equatable { case notApplicable, openCardApp, blocked }
    /// 이동 요청의 scheme 판정. http/https/about/blob/data/file 은 이 모듈의 관심사가 아니다.
    static func decide(urlScheme: String?, paymentContext: Bool) -> SchemeDecision {
        guard let s = urlScheme?.lowercased(), !s.isEmpty else { return .notApplicable }
        if ["http", "https", "about", "blob", "data", "file"].contains(s) { return .notApplicable }
        if cardAppSchemes.contains(s) { return .openCardApp }   // 카드사 앱 호출은 결제 문맥이 아니어도 허용 목록 안이면 같은 처리(미설치 안내 포함)
        return paymentContext ? .blocked : .notApplicable
    }
}
