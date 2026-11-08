# iOS 실기기 NICEPAY 결제창 오류 진단 (2026-11-08) — 기준 `fd659321`(운영 배포)

## 증상
카드 결제창 확인(조회 전용 심사 경로) → 외부 Safari(`web.nicepay.co.kr`)가 열리고 "일시적인 오류가 발생하였습니다". 일반 Safari 에서는 같은 경로가 성공. 주문·예약·수강권 미생성.

## 확인된 원인(코드·SDK·네이티브 소스·실제 요청으로 확인)
1. **NICEPAY 모바일 결제창은 form POST 최상위 이동으로 열린다.** 공식 SDK `nicepay-pgweb.js`(실제 파일을 Chromium 모바일 에뮬레이션으로 실행, 외부 전송 없이 요청만 기록)의 `goPay()` 는 모바일에서 `target="_top"`, `NpSvcType=SMART` 를 붙여 **`POST https://pg-web.nicepay.co.kr/v3/gwPayment.jsp`**(MID·Moid·Amt·GoodsName·EdiDate·SignData·PayMethod·ReturnURL·NpSvcType)를 최상위 탐색으로 보낸다.
2. **설치 앱의 Capacitor(8.5.1 iOS)는 allowNavigation 에 없는 호스트로의 최상위 이동을 `UIApplication.shared.open(URL)` 후 취소한다**(`WebViewDelegationHandler.decidePolicyFor`). 외부로 넘기는 것은 URL 뿐이라 **POST 본문이 소실**된다. 현재 목록은 kakao·naver·google·apple·supabase 뿐(`capacitor.config.ts`) → Safari 가 본문 없는 GET 으로 `pg-web.nicepay.co.kr` 를 열고, NICEPAY 가 `web.nicepay.co.kr` 오류 페이지를 보여 준다. 일반 Safari 는 이 가로채기가 없어 성공 — 증상과 정확히 일치.
3. **이동 경로(공용·빌링 테스트 MID 로 실제 확인, 카드 입력·승인 없음):** `pg-web.nicepay.co.kr/v3/gwPayment.jsp`(200, 자동 POST HTML) → `dc1-web.nicepay.co.kr/v3/smart/smartPayment.jsp?…ServiceCode=GSLB`(GSLB 로 배정) → 같은 호스트의 `…/smart/billing/payment.jsp`(결제창 본체). 즉 **WebView 가 허용해야 하는 호스트는 최소 `pg-web`·`dc1-web`**(둘 중 하나라도 막히면 그 단계에서 다시 외부 GET 으로 넘어가 같은 오류). `web.nicepay.co.kr` 은 오류/안내 페이지로 관찰됨. 서명이 틀린 요청은 `error.jsp?errCd=W007…`(내부 오류코드가 URL 에 실림).
4. 요청값 형식·인코딩은 정상: 일반 Safari 에서 같은 서명·필드로 창이 열렸고(서버 검증·Signature 통과), form 은 `accept-charset=euc-kr`·`CharSet=utf-8`·ReturnURL 은 앱 origin.

## 수정(최소): `capacitor.config.ts` allowNavigation 에 정확한 호스트 3개 추가
`pg-web.nicepay.co.kr`, `dc1-web.nicepay.co.kr`, `web.nicepay.co.kr`. 와일드카드(`*`, `*.nicepay.co.kr`)는 쓰지 않았고, 카드사·ISP 앱 이동 호스트는 추가하지 않았다(결제창 첫 화면 확인 범위 밖). 결제 로직·PG 플래그·서버 코드·SQL·네이티브 소스는 변경 없음.
- **네이티브 번들에 포함되는 설정이라 iOS 앱 재빌드·재설치가 필요하다**(웹 배포만으로는 기존 설치 앱이 바뀌지 않음). Android 도 같은 설정을 쓰므로 Android 앱도 다시 빌드해야 같은 효과(Android 는 이번에 별도 검증하지 않음).
- 영향 검토: 소셜 로그인 호스트·Supabase·앱 링크(`applinks:mwhabit.com`)·푸시·상태바 코드는 건드리지 않음(설정 항목 추가만). 허용된 NICEPAY 페이지는 WebView 안에서 열리므로 Capacitor 브리지 접근 범위가 그 호스트까지 넓어진다 — 소셜 로그인 호스트와 같은 수준의 신뢰를 정확한 호스트로 한정.
- **PR #264 와의 관계**: #264 는 같은 배열에 `*.nicepay.co.kr` 와일드카드와 네이티브 변경 10개 파일(WapUrl 복귀 scheme 등)을 이미 담고 있다. 이 변경은 #264 를 수정하지 않는 임시·최소 수정이며, 둘이 함께 병합되면 같은 배열에서 텍스트 충돌이 난다(해결: #264 의 항목을 채택하거나 정확한 호스트 3개만 유지 — 정책 결정 필요).

## 검증
- 단위: `tests/unit/capacitorNicepayNavigation.test.ts` 5건 — Capacitor 판정(`doesHost`·`decidePolicyFor`)을 옮긴 모델로 (수정 전) POST 이동이 외부 처리·취소되고 (수정 후) 3개 호스트 체인이 허용되며, 와일드카드·`dc2-web`·`webapi`·유사 도메인은 계속 외부 처리, 기존 허용 목록·ReturnURL(앱 origin)·하위 프레임 동작 불변, form 구조(POST, 허용 필드만, 키 없음). **모델 시험이며 실제 WKWebView 시험이 아니다.**
- 실제 SDK 요청 구조(Chromium 모바일 에뮬레이션, 외부 전송 0): `POST pg-web…/v3/gwPayment.jsp`, 최상위 탐색, 필드 9개.
- iOS 빌드: `npx cap copy ios` 로 번들 설정에 3개 호스트 반영 확인 + `xcodebuild`(시뮬레이터 Debug, 서명 없음) **BUILD SUCCEEDED**, 앱 번들 `capacitor.config.json` 에 포함 확인(빌드용 `GoogleService-Info.plist` 는 기존 저장소 사본을 임시로 복사했다가 삭제, 커밋 없음). 실기기 설치·실행은 하지 않았다.

## 아직 확인되지 않은 가설(실기기 QA 필요)
1. WebView 안에서 NICEPAY 결제창 본체가 끝까지 동작하는지(쿠키 `JSESSIONID`·iframe·약관 팝업 `window.open` → Capacitor 가 외부로 연다).
2. GSLB 가 `dc1-web` 외 호스트(`dc2-web` 등)를 배정할 수 있는지(그러면 그 호스트도 필요 → NICEPAY 확인 필요).
3. 공용 테스트 MID(nicepay00m)의 모바일 결제창 제약 — 일반 Safari 성공으로 가능성 낮음.
4. `WapUrl`/`IspCancelUrl`: 카드사·ISP **앱을 호출했다가 돌아오는** 일반 결제(#264) 경로에는 필요하지만, 조회 전용 review-window(#265, 결제창 첫 화면 확인·카드 입력 없음)에는 필요하지 않다고 본다(공식 문서의 앱 복귀 항목은 카드사 앱 이동 단계 한정). 카드 입력까지 진행하면 카드사 호스트·앱 이동이 생겨 #264 범위가 필요하다.

## 안전한 오류 진단 방법(내부 오류코드 확보)
- NICEPAY 오류 페이지의 주소에 `errCd=Wxxx`(예: 서명 불일치 W007)가 실린다. 외부 Safari 에서 오류를 만났을 때 **주소창의 `errCd`·`errStatus` 값만** 기록(`token` 값은 지우고 공유).
- 수정 후 앱 안에서는 주소창이 없으므로: 디버그 빌드를 Mac 에 연결해 Safari 개발자 도구(개발 → 기기 → 앱의 WebView)로 네트워크 탭의 `gwPayment.jsp`/`smartPayment.jsp`/`error.jsp` 요청과 응답 코드를 확인(디버그 빌드 한정, 운영 앱에서는 불가).
- 서버 쪽: 복귀 URL 처리기는 서명·금액·Moid 만 검사하고 값을 로그에 남기지 않는다(변경 없음). 서명 오류 여부는 로컬에서 같은 입력으로 NICEPAY 서명 수식(`sha256(EdiDate+MID+Amt+MerchantKey)`)을 재계산해 확인.

## 실기기 재검증 절차(사용자 수행)
1. 이 변경을 포함해 iOS 앱을 **재빌드·재설치**(웹만 배포해서는 반영되지 않는다).
2. niceqa 로그인 → A10TION 상품 → "결제 화면 확인" → "카드 결제창 확인": **앱 안에서** NICEPAY 카드 등록/결제창 첫 화면이 열리는지(외부 Safari 로 나가지 않는지).
3. 카드번호·인증은 입력하지 않고 닫기 → 모하빗 앱 결제 화면으로 복귀하는지, 신규 주문·예약·수강권이 없는지.
4. 오류가 나면 위 방법으로 `errCd` 만 전달.
