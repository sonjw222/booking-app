# 앱 내비게이션 전수 점검 (2026-11-09, 4·5번)

범위: iOS(WKWebView)/Android(Capacitor) 뒤로가기·가장자리 제스처 정책. 코드 근거는 `lib/backPolicy.ts`, `app/components/NavigationPolicy.tsx`, `ios/App/App/NavigationPolicyPlugin.swift`.

## 발견한 문제와 원인
| # | 문제 | 원인 |
|---|---|---|
| 1 | 오른쪽 가장자리 "앞으로" 제스처가 동작 | `allowsBackForwardNavigationGestures` 는 양방향을 한 스위치로 켠다(공개 API 로 방향 분리 불가) |
| 2 | ‹ 버튼과 스와이프 도착 화면이 다를 수 있음 | ‹ 는 고정 href(`/mypage`, `/admin` …) 또는 router.back, 스와이프는 WebView 히스토리 |
| 3 | 시트/모달이 열린 채 스와이프·Android back 하면 배경 화면이 이동 | `SheetOverlay` 가 back 과 연동되지 않음 |
| 4 | 딥링크 첫 진입에서 Android back 이 앱 종료 | `canGoBack=false` → `exitApp()` (안전 fallback 없음) |
| 5 | 매니저 설정(변경 사항 확인) 중 스와이프는 확인창 우회 | WebView 히스토리 이동이 `confirmDiscardChanges` 를 거치지 않음 |

## 정책 (모든 입력 공통: ‹ 버튼 / iOS 왼쪽 가장자리 / Android back)
1. 확인 대화상자(`role=alertdialog`)가 열려 있으면 아무 이동도 하지 않는다.
2. 시트/모달(`[data-sheet-overlay]`)이 열려 있으면 최상단 오버레이만 닫는다(배경 클릭과 같은 경로 → 기존 닫기 가드 유지).
3. root 탭 화면이면 back 없음(iOS 스와이프 비활성, Android 는 앱 종료 관례). 탭 전환은 기존 `replaceTabNavigation` 유지.
4. 그 외: 화면의 ‹ 컨트롤이 하는 일과 동일하게 동작(등록된 화면 핸들러 → 헤더 ‹ 컨트롤 클릭 → 모드 홈 fallback). 앱 안 이전 화면이 있으면 router.back, 딥링크 첫 진입이면 고정 fallback.
5. iOS: 내장 양방향 제스처는 끄고(`allowsBackForwardNavigationGestures=false`), 공개 API `UIScreenEdgePanGestureRecognizer`(왼쪽 가장자리) 가 `window.__mwhabitBack()` 을 호출 → 오른쪽 "앞으로" 제스처는 존재하지 않음. 가장자리 20pt 밖의 터치는 인식기가 가져가지 않으므로 가로 스크롤·캐러셀·캘린더·지도·사진 뷰어·시트 드래그·텍스트 선택은 영향 없음.

## 화면 유형별 표
(✔ 예 / ✖ 아니오 / — 해당 없음. "실기기"는 BLOCKED 항목)

| 화면 유형 | ‹ 버튼 | 왼쪽 가장자리 | 오른쪽(앞으로) 차단 | 실제 이전 화면 복귀 | 탭/모드 전환 충돌 | 오버레이 열림 |
|---|---|---|---|---|---|---|
| 홈/탭 5종(`/`,`/reservation`,`/my-reservations`,`/notifications`,`/mypage`) | ✖ | 비활성 | ✔ | — | replace 정책 유지 | 오버레이만 닫음 |
| 검색/종목 목록 | ✔(BackButton) | 활성 | ✔ | router.back(진입 목록) | 없음 | 오버레이만 닫음 |
| 센터 상세 / 클래스 상세 | ✔(BackButton) | 활성 | ✔ | 직전 화면, 딥링크는 fallback | 없음 | 오버레이만 닫음 |
| 수강권 구매·장바구니·구매내역 | ✔(BackButton) | 활성 | ✔ | 직전 화면 | 없음 | 구매 시트 열림 → 시트만 닫힘 |
| 체크아웃 | ✔(고정 `centerBackHref`) | 활성(‹ 클릭과 동일) | ✔ | ‹ 와 동일 도착 | 없음 | 확인창 중에는 이동 안 함 |
| 예약 / 내 예약 | root 탭(✖) / 상세는 ✔ | 탭 비활성, 상세 활성 | ✔ | 직전 화면 | 탭은 replace | 오버레이만 닫음 |
| 알림 | root 탭(✖) | 비활성 | ✔ | — | replace | — |
| 마이페이지 하위(설정·문의·소개 등) | ✔(고정 `/mypage` 등) | 활성(‹ 와 동일) | ✔ | ‹ 와 동일 | 없음 | 오버레이만 닫음 |
| 로그인/가입 | 화면별 | root 아님 → 활성(‹ 있으면 동일) | ✔ | ‹ 와 동일 | 없음 | — |
| 센터 관리자 root 4탭 | ✖ | 비활성 | ✔ | — | replace | — |
| 센터 관리자 하위 | ✔(ManagerChrome) | 활성 | ✔ | 변경 확인 후 ‹ 와 동일 | 설정은 `/manager` | 오버레이만 닫음 |
| 플랫폼 운영자 `/admin` | ✖ | 비활성 | ✔ | — | replace | — |
| 플랫폼 운영자 하위 | ✔(AdminChrome/고정 `/admin`) | 활성 | ✔ | ‹ 와 동일 | 없음 | 오버레이만 닫음 |
| 시트/모달/대화상자 | — | 오버레이만 닫음(대화상자는 무시) | ✔ | — | — | 배경 히스토리 이동 없음 |
| 딥링크 첫 진입 | ✔ | 활성 | ✔ | 앱 이전 화면 없음 → 모드 홈 fallback | — | — |
| NICEPAY 외부 호스트 | 외부 페이지 | 네이티브 인식기 비활성(웹 브리지 없음) | — | 기존 NICEPAY 동작 유지 | Safe Area/allowNavigation 불변 | — |
| 지도/사진 뷰어/캐러셀/캘린더 | — | 왼쪽 20pt 가장자리 밖 영향 없음 | — | — | — | — |

## 남은 위험 / 실기기 확인(BLOCKED)
- 실기기 가장자리 제스처의 체감·충돌(캐러셀이 화면 왼쪽 끝까지 닿는 화면), 오른쪽 스와이프 차단 실측.
- 페이지 로딩 실패/오프라인 화면에서는 `window.__mwhabitBack` 이 없어 스와이프가 동작하지 않을 수 있음(그 경우 네이티브가 `webView.goBack()` 로 폴백).
