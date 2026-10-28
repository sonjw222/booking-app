# NICEPAY 공식 연동 규격 분석 (계약 전) — 2026-10-17

출처(공개 문서 열람만, 실제 호출 없음): developers.nicepay.co.kr (개발자센터 메인 — 인증결제 `/docs/pg/intro`, 비인증 `/docs/pg/non-auth/intro`, 결제통보 `/docs/pg/add/noti`, 결과코드 `/docs/pg/result-code/intro`),
github.com/nicepayments/nicepay-manual (`api/payment-window-server.md`, `api/payment-window-client.md`, `api/cancel.md`, `api/status-transaction.md`, `api/hook.md`, `common/api.md`, `common/preparations.md`).

## 1. 연동 계열은 두 가지다 — 계약에서 발급되는 키 유형이 어느 쪽인지 아직 모른다
| 항목 | REST(v1) 계열 (nicepay-manual) | v3 MID 기반 계열 (기존 `lib/payments/server/nicepay/{api,lifecycle,signature}.ts`) |
|---|---|---|
| 자격증명 | clientId(클라이언트 키) + secretKey | MID + MerchantKey |
| 결제창 | JS SDK `AUTHNICE.requestPay()` (`pay.nicepay.co.kr/v1/js/`, 샌드박스 `sandbox-pay…`) | `nicepay-pgweb.js goPay` (form POST) |
| 인증 결과 | returnUrl POST: `authResultCode=0000`, `tid`, `orderId`, `amount`, `authToken`, `signature` | returnUrl POST: `AuthResultCode`, `TxTid`, `Moid`, `Amt`, `AuthToken`, `Signature`, `NextAppURL`, `NetCancelURL` |
| 인증 서명 | `sha256(authToken + clientId + amount + SecretKey)` | `sha256(AuthToken + MID + Amt + MerchantKey)` |
| 서버 승인 | `POST api.nicepay.co.kr/v1/payments/{tid}` JSON `{amount, ediDate, signData}`, 헤더 `Authorization: Basic base64(clientId:secretKey)` | `NextAppURL`(허용 호스트)로 form POST |
| 승인 서명 | 요청 `signData = sha256(tid + amount + ediDate + SecretKey)`, 응답 `signature = sha256(tid + amount + ediDate + SecretKey)` | 요청 `sha256(AuthToken+MID+Amt+EdiDate+Key)`, 응답 `sha256(TID+MID+Amt+Key)` |
| 성공 코드 | `resultCode "0000"` + `status "paid"` | 카드 `3001` |
| 취소 | `POST /v1/payments/{tid}/cancel` `{reason, orderId(취소 요청 번호), cancelAmt?(생략=전액), signData=sha256(tid+ediDate+Key)}` → `status cancelled`, `balanceAmt` | 취소 URL(문서 확인 필요), 성공 `2001`/`2211` |
| 망취소 | `POST /v1/payments/netcancel` `{orderId, signData=sha256(orderId+ediDate+Key)}`, **요청 후 1시간 내**, orderId 유일해야 정상 | `NetCancelURL`로 POST, 성공 `2001` |
| 거래 조회 | `GET /v1/payments/{tid}`, `GET /v1/payments/find/{orderId}?orderDate=YYYYMMDD` (응답 signature 동일 공식) | 문서에서 확인되지 않음 |
| 웹훅 | JSON, `signature = sha256(tid + amount + ediDate + SecretKey)`, 응답은 200 `text/html` 본문 `OK` | 서명 없음(분류 전용) |
| 타임아웃 | 연결 5초 / 응답 30초, **read-timeout 후 망취소** | 동일 |
| 호스트 | 운영 `api.nicepay.co.kr`, 샌드박스 `sandbox-api.nicepay.co.kr` (방화벽: 운영 API 121.133.126.83/27, 웹훅 inbound 121.133.126.86·87) | `dc1-api/dc2-api/webapi.nicepay.co.kr` 등 |

## 2. 승인 모델
- **Server 승인 모델**(대량 트래픽 권장): 브라우저는 인증만 하고 승인은 우리 서버가 호출 → **이 프로젝트가 채택**(금액·주문 검증 후에만 승인, 서버가 돈 이동 시점을 통제).
- **Client 승인 모델**(하루 10건 이하 권장): 브라우저 JS SDK가 승인까지 처리. 문서가 "client-side에서 금액이 변조되면 변조된 금액으로 승인될 수 있다"고 경고 → 모든 건에 **승인금액 검증 API**(`isValid`)가 필요하나 그 API 명세는 확인한 문서에 없음 → **채택하지 않음**(BLOCKED).
- 키 유형이 승인 모델을 정한다("클라이언트 키 타입에 따라 Server/Client 결정"). 계약 시 **Server 승인 모델 키**를 요청해야 한다.

## 3. 모바일 WebView
`appScheme`은 "가맹점 독립 앱의 WebView 연동"에서만 쓰며 카드사 인증 후 앱으로 포커스를 되돌리는 용도(예: `nicepaysample://`). 세부는 `api/app-ios.md`, `api/app-android.md`. 이 프로젝트는 Capacitor WebView + 외부 Safari 복귀가 섞여 있어 **주문 전용 서명 복귀 토큰(rt)**으로 로그인 세션 없이 결과를 확인한다. `appScheme`/Universal Link 설정은 계약 후 기술지원 확인(BLOCKED).

## 4. 이번에 구현한 것 / 구현하지 않은 것
- 구현(문서에 명시된 공식·엔드포인트만): REST 서명 5종, 승인/망취소/취소/조회/주문번호 조회/웹훅 검증, 호스트 허용 목록, Basic 인증, 타임아웃 30초, 서명 검증된 응답만 신뢰.
- **추측하지 않고 대체한 것**: ① 취소 응답의 서명 공식(문서 미기재) → 취소 직후 **조회 API의 서명 검증된 응답**으로 취소를 재확인 ② 이미 취소된 거래 재요청 응답(문서 미기재) → 응답 코드에 의존하지 않고 조회로 판단 ③ 멱등성 보장 여부(문서 미기재) → 취소 요청 번호를 `cx-{orderId}`로 결정적으로 고정 + 조회로 재확인 ④ ediDate 정확한 포맷("ISO 8601"만) → KST 오프셋 `+09:00` 가정(샌드박스 확인 필요).
- 구현하지 않음(BLOCKED): Client 승인 모델/승인금액 검증 API, 부분취소, 가상계좌·휴대폰·계좌이체 결제수단, v3 결제창(nicepay-pgweb.js) 클라이언트, 현금영수증, Bearer 토큰 방식(`/v1/access-token`), appScheme/앱 연동, 정기결제(빌링) API.
