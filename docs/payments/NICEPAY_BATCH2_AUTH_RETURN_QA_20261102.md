# NICEPAY Batch 2 — 인증 복귀·iOS/Android WebView 연동 QA (2026-11-02)

범위: 인증 전용(auth-only) 환경에서 "인증 결과 복귀 → 서버 검증 → 승인 없이 중단 → 주문 cancelled → 결과 화면"과 앱(WebView) 복귀 설정(#255)의 결합 검증. 실제 승인·청구 0건, 운영 DB·Vercel·MID/KEY 변경 없음, SQL 없음.

## 1. 브랜치 관계
- `qa/nicepay-real-window-20261102`(`58ae8fa`, 로컬): PR #259(auth-only QA) 기반 + 로컬 스택 준비 스크립트.
- `qa/nicepay-native-return-20261102`(로컬): 위 브랜치 + #255 네이티브 구현 커밋(`b6cad89`)을 cherry-pick(충돌 4건 수동 해결: result page·config.ts·CHANGELOG·TODO — 두 기능 모두 유지) + 앱+auth-only 결합 시험 + 낡은 단위 시험 1건 수정.
- 기본 저장소(`~/Documents/booking-app`)는 읽기만 했다. 이 브랜치의 `Info.plist`·`project.pbxproj`·`build.gradle` 변경은 기본 저장소의 미완료 네이티브 수정과 **병합 시 충돌 가능** — 병합 전 사용자 검토 필요.

## 2. 2TR 구조와 코드 일치 확인 (공식 문서 승인 API 페이지 재확인 + 코드 점검)
- 공식: 인증 응답의 AuthToken·TxTid·NextAppURL 을 변조 없이 승인 요청에 사용, 승인 응답을 받아야 결제 완료.
- 코드: `AuthResultCode==="0000"` 은 "인증 성공"일 뿐. `lifecycle.ts` 가 서명·MID·금액·주문·게이트·NextAppURL 허용 호스트를 검증한 뒤, auth-only 이면 **주문 선점(claim)·승인 호출 이전에** 종료 → `flow.ts` 가 대기 주문을 cancelled 로 정리하고 결과 화면은 `qa=auth_only` 안내만 표시("결제 완료" 문구 없음). 인증 실패/카드사 취소는 승인 전 pending 주문만 취소. 중복 POST 는 claim 이전 종료라 상태 불변(토큰·소유 검증 통과분만 처리).
- `NICEPAY_QA_AUTH_ONLY` 서버 설정이 아니어도 공용 테스트 MID(`nicepay00m`)면 auth-only 강제. 운영 MID/운영 Supabase/production 환경이면 NICEPAY 설정 자체를 거부, 서버 fetch 의 `*.nicepay.co.kr` 호출은 `guardFetch` 가 차단.

## 3. 검증 결과 (모두 로컬 격리, 모의 결제창 — 실제 외부 카드 인증 아님)
| 항목 | 결과 |
|---|---|
| Vitest 전체 | 통과(2967+, 아래 최종 수치 참고) |
| auth-only 격리 브라우저(웹) | 11/11 PASS, 승인·망취소·외부 호출 0 |
| auth-only + 앱 복귀 설정 ON(`authOnlyApp.spec.ts`, iOS/Android Capacitor 모의) | 5/5 PASS — WapUrl/IspCancelUrl(서버 scheme+주문 UUID)·비밀 필드 없음·인증 완료 후 승인 0·cancelled·"완료" 미표시, 창 닫기 정리, 카드사 앱 취소(IspCancel) 복귀는 본인 pending 만 취소 |
| 앱 복귀 QA(`nativeAppReturn.spec.ts`, 승인 경로 모의) | 8/8 PASS |
| 기본 모드 결제 회귀 | 31 PASS(20 skip=다른 모드 전용) |
| iOS | Swift 순수 로직 검사 PASS · `xcodebuild` 시뮬레이터 Debug 빌드 PASS(URL scheme 3개, `LSApplicationQueriesSchemes` 29개) |
| Android | JUnit `NicepayAppReturnTest` 9/9 PASS · `assembleDebug` PASS(복귀 scheme 1개, `queries` 24개) |
| 실제 외부 결제창 열기·닫기 | PASS(2026-11-02 Mac 로컬, 사용자 실행) — 이번 배치에서 재실행하지 않음 |
| 실제 외부 카드 인증 → ReturnURL 복귀 | **BLOCKED** — 공식 테스트 인증 수단 확인 + 사용자 승인 필요 |
| iOS/Android 실기기·시뮬레이터 런타임, 카드사 앱 호출·복귀 | **BLOCKED** — 앱은 `server.url` 로 운영 도메인을 로드하므로 시뮬레이터 실행 시 운영 서버에 닿는다. 비운영 HTTPS 테스트 서버 + 앱 설정 + 카드사 앱 설치 필요 |

## 4. 수정 내역
- 낡은 단위 시험 수정: `nicepayAppReturn.test.ts` 의 "코드 상수 꺼짐이면 비활성" 은 #258(상수 true) 이전 가정 → 코드 상수 false(주입)·서버 스위치 false 두 경우로 갱신. 가드 완화 없음.
- 신규 `tests/nicepay-qa/authOnlyApp.spec.ts`.

## 5. localhost ReturnURL 접근성
브라우저가 ReturnURL 로 POST 하므로 같은 PC 의 `http://localhost:3100` 은 동작(결제창 열기·닫기 확인됨). **휴대폰/에뮬레이터의 WebView 는 localhost 에 닿지 않는다** → 실기기·시뮬레이터 인증 복귀 시험은 비운영 HTTPS 주소(예: 브랜치 Preview + 비운영 DB, 또는 터널)가 필요하다. 운영 환경에 설정을 복사하지 않는다. 앱 쪽은 서버 설정 `NICEPAY_APP_RETURN_ENABLED`/`SCHEME` 도 해당 환경에만.

## 6. 사용자 다음 작업 (한 단계씩)
1. NICEPAY 기술지원에 확인: (a) `nicepay00m` 으로 가능한 공식 테스트 인증 수단(카드/인증 방식), (b) WapUrl/IspCancelUrl 값 형식, (c) localhost/비운영 HTTPS ReturnURL 허용.
2. 위 답변 전에는 외부 카드 인증을 시도하지 않는다.
