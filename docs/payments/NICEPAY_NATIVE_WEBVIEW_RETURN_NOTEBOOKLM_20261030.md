# NICEPAY 모바일 앱(WebView) 결제 복귀 — NotebookLM 업로드용 요약 (2026-10-30, Issue #255)

서비스: 모하빗(MWHABIT) — Capacitor 앱(iOS·Android)이 `https://mwhabit.com` 을 WebView 로 띄우는 구조. 상세 근거·표는 `docs/payments/NICEPAY_NATIVE_WEBVIEW_RETURN_20261030.md`.

## 한 문장
앱에서 NICEPAY v3 결제 중 카드사·ISP 앱으로 갔다가 모하빗으로 안전하게 돌아오는 코드를 만들고 로컬에서 검증했다. **결제 OFF·앱 복귀 서버 설정 OFF 가 기본이라 운영에는 아무 영향이 없고**, 정확한 값 형식·scheme 은 NICEPAY 확인 전이라 활성화하지 않았다.

## 무엇이 문제였나
- 결제창 호출 규격에 WebView 결제용 `WapUrl`(카드사 앱 인증 후 가맹점 앱으로 복귀할 scheme), `IspCancelUrl`(ISP 취소 시 복귀)이 있는데 구현에 없었다.
- Capacitor 기본 동작은 허용 목록 밖 이동을 모두 바깥 브라우저/앱으로 넘긴다 → 결제창이 앱 밖에서 열리고, Android `intent://` 는 열리지 않으며, 카드사 앱 미설치 안내가 없고, 결제 화면에서 임의 scheme 이 검증 없이 열릴 수 있었다.

## 어떻게 만들었나
- **서버가 정한다**: 서버 설정이 켜져 있고 클라이언트가 "iOS/Android 앱"이라고 알릴 때만 `WapUrl`/`IspCancelUrl` 을 보낸다. URL 은 서버 scheme + DB 주문 UUID 로만 만들고 클라이언트가 보낸 값은 무시한다. 복귀 URL 에는 토큰·키가 없다. 웹 브라우저(PC·모바일)와 설정 OFF(기본)에는 필드가 없어 기존 결제 흐름이 그대로다.
- **복귀 ≠ 성공**: 앱으로 돌아왔다는 사실은 결제 성공이 아니다. 결과 화면이 로그인 세션으로 서버에 상태를 묻고 DB 주문이 `done` 일 때만 완료로 보여준다. ISP 취소 복귀는 본인의 승인 전 주문만 정리한다. 진행 중인 인증 흐름 화면에서는 복귀가 화면을 바꾸지 않아 승인 흐름을 끊지 않는다.
- **iOS**: 기존 Google 로그인 scheme 유지, 복귀 scheme 추가, 카드사 앱 scheme 29개 등록(`LSApplicationQueriesSchemes`), 플러그인이 카드사 앱 호출·미설치 안내(ISP 는 App Store)·결제 화면의 임의 scheme 차단. Google 처리 뒤에서만 우리 scheme 을 가져간다. ATS 전체 허용 없음.
- **Android**: `queries` 24개 패키지, 복귀 deep link 1개, `intent://`·`market://` 는 허용 패키지만(component/selector/flags/extras 제거, VIEW+BROWSABLE 만), 미설치면 허용 패키지의 스토어로만 안내, 앱 재시작·재진입 처리.
- **허용 목록**: 공식 문서 표의 신용카드·공동인증·백신만. 카카오톡·네이버 등 소셜 로그인과 겹치는 scheme 은 제외(로그인 회귀 방지).

## 검증(실제 NICEPAY·실기기 없음)
단위 테스트(서버 prepare·form 검증·복귀 URL 위조 차단·허용 목록·웹/iOS/Android 소스 동일성), Swift 순수 로직 검사, Android JUnit 9건, Android `assembleDebug` 와 iOS 시뮬레이터 `xcodebuild` 빌드 성공, 격리 브라우저 QA(앱 환경 모의: 필드 구성·결제 완료는 서버 승인 후에만·복귀 위조/중복/타인 주문/세션 없음·ISP 취소·승인 실패 시 미완료 유지·결제 OFF). **네이티브 빌드 성공은 실기기 카드사 인증 성공과 별개이며, 실기기 인증·복귀는 BLOCKED.**

## 아직 NICEPAY 확인이 필요한 것(추측해서 켜지 않음)
`WapUrl`/`IspCancelUrl` 값 형식(문서 예시는 `nicepaysample://` 뿐), 가맹점 scheme 확정(제안 `mwhabitnicepay`, 스토어 제출 후 변경 불가), 카드사 인증 페이지 도메인 목록(앱 WebView 허용 목록), 앱 호출 목록 최신본, 실기기 흐름. 확정 뒤 서버 설정 2개(`NICEPAY_APP_RETURN_ENABLED`, `NICEPAY_APP_RETURN_SCHEME`)와 네이티브 재빌드·스토어 제출이 필요하다.

## 별도 주의
공식 문서가 GoodsName 의 대괄호·쌍따옴표 등 특수기호는 별도 문의라고 했는데, PR #254 의 GoodsName 정리는 대괄호를 허용한다 → NICEPAY 확인 전까지 공백 처리가 안전(후속 수정 TODO).
