import Foundation

// ios/App/App/NicepayAppReturn.swift 단독 검사(Foundation 만) — `swiftc -o /tmp/np ios/App/App/NicepayAppReturn.swift scripts/native/nicepayAppReturnCheck/main.swift && /tmp/np`.
// tests/unit/nicepayNativeParity.test.ts 가 swiftc 가 있을 때 실행한다. 실패하면 종료 코드 1.
var failures = 0
func check(_ cond: Bool, _ msg: String) { if !cond { failures += 1; print("FAIL: \(msg)") } }

let ORDER = "22222222-2222-4222-8222-222222222222"
let S = NicepayAppReturn.scheme

check(NicepayAppReturn.parse("\(S)://nicepay/wap?orderId=\(ORDER)") == .init(kind: .wap, orderId: ORDER), "wap 정상")
check(NicepayAppReturn.parse("\(S)://nicepay/cancel?orderId=\(ORDER)") == .init(kind: .cancel, orderId: ORDER), "cancel 정상")
let bad = [
    "other://nicepay/wap?orderId=\(ORDER)", "\(S)://evil/wap?orderId=\(ORDER)", "\(S)://nicepay/other?orderId=\(ORDER)", "\(S)://nicepay/?orderId=\(ORDER)", "\(S)://nicepay?orderId=\(ORDER)",
    "\(S)://nicepay/wap", "\(S)://nicepay/wap?orderId=", "\(S)://nicepay/wap?orderId=\(ORDER)&x=1", "\(S)://nicepay/wap?x=1&orderId=\(ORDER)", "\(S)://nicepay/wap?orderId=\(ORDER)#f",
    "\(S)://user@nicepay/wap?orderId=\(ORDER)", "\(S)://nicepay:80/wap?orderId=\(ORDER)", "\(S)://nicepay/wap?orderId=AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE", "\(S)://nicepay/wap?orderId=not-a-uuid",
    "\(S)://nicepay/wap?orderId=\(ORDER)%0d%0a", "\(S)://nicepay/wap/../cancel?orderId=\(ORDER)", " \(S)://nicepay/wap?orderId=\(ORDER)", "\(S)://nicepay/wap?orderId=\(ORDER)" + String(repeating: "a", count: 600),
    "javascript:alert(1)", "https://mwhabit.com/wap", "",
]
for u in bad { check(NicepayAppReturn.parse(u) == nil, "거부해야 함: \(u.prefix(60))") }

check(NicepayAppReturn.resultPath(.init(kind: .wap, orderId: ORDER)) == "/checkout/nicepay/result?orderId=\(ORDER)&app=1", "wap 경로")
check(NicepayAppReturn.resultPath(.init(kind: .cancel, orderId: ORDER)) == "/checkout/nicepay/result?orderId=\(ORDER)&app=1&cancel=1", "cancel 경로")

let H = "mwhabit.com"
func u(_ s: String) -> URL? { URL(string: s) }
check(NicepayAppReturn.shouldNavigate(kind: .wap, currentURL: u("https://pg-web.nicepay.co.kr/v3/x"), appHost: H) == false, "NICEPAY 화면에서는 wap 이동 없음")
check(NicepayAppReturn.shouldNavigate(kind: .wap, currentURL: u("https://web.nicepay.co.kr/"), appHost: H) == false, "web.nicepay")
check(NicepayAppReturn.shouldNavigate(kind: .wap, currentURL: u("https://\(H)/checkout?center=1"), appHost: H) == false, "checkout 화면")
check(NicepayAppReturn.shouldNavigate(kind: .wap, currentURL: u("https://\(H)/"), appHost: H) == true, "홈이면 이동")
check(NicepayAppReturn.shouldNavigate(kind: .wap, currentURL: nil, appHost: H) == true, "콜드 스타트")
check(NicepayAppReturn.shouldNavigate(kind: .cancel, currentURL: u("https://pg-web.nicepay.co.kr/v3/x"), appHost: H) == true, "cancel 은 항상")

// scheme 판정: 카드사 허용 목록은 열고, 결제 문맥의 그 밖 custom scheme 은 막고, 일반 화면의 그 밖 scheme/https 는 기존 동작(notApplicable).
check(NicepayAppReturn.decide(urlScheme: "ispmobile", paymentContext: true) == .openCardApp, "ispmobile")
check(NicepayAppReturn.decide(urlScheme: "KB-ACP", paymentContext: false) == .openCardApp, "대소문자 무관")
check(NicepayAppReturn.decide(urlScheme: "evilapp", paymentContext: true) == .blocked, "결제 문맥 임의 scheme 차단")
check(NicepayAppReturn.decide(urlScheme: "evilapp", paymentContext: false) == .notApplicable, "일반 화면은 기존 동작")
for s in ["kakaotalk", "naversearchthirdlogin", "supertoss", "com.googleusercontent.apps.123", "kakao123"] { check(NicepayAppReturn.decide(urlScheme: s, paymentContext: false) == .notApplicable, "로그인 scheme 은 건드리지 않음: \(s)") }
check(NicepayAppReturn.decide(urlScheme: "https", paymentContext: true) == .notApplicable, "https 는 관심 밖")
check(NicepayAppReturn.decide(urlScheme: nil, paymentContext: true) == .notApplicable, "scheme 없음")
check(NicepayAppReturn.isPaymentContext(currentURL: u("https://pg-web.nicepay.co.kr/"), appHost: H), "문맥 NICEPAY")
check(!NicepayAppReturn.isPaymentContext(currentURL: u("https://\(H)/login"), appHost: H), "로그인은 결제 문맥 아님")
check(!NicepayAppReturn.isPaymentContext(currentURL: u("https://evil-nicepay.co.kr.attacker.test/"), appHost: H), "호스트 위장")
check(!NicepayAppReturn.isNicepayHost("nicepay.co.kr.evil.com"), "접미사 위장")

if failures == 0 { print("OK: NicepayAppReturn swift checks passed") }
exit(failures == 0 ? 0 : 1)
