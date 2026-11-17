# 수강권 안내창 — 드래그 부드러움·간헐적 흰 레터박스 (2026-11-16, 기준 Production 4093ee62)

실기기 QA: 아래로 끌 때 움직임이 부자연스럽고, 같은 동작에서도 어떤 때는 정상적으로 닫히고 어떤 때는 시트가 내려간 채 닫히지 않아 화면 아래에 흰 빈 영역이 남는다.

## 원인 (검증 가능 여부 구분)
| # | 원인 | 검증 |
|---|---|---|
| 1 | **터치 이벤트가 시트로 돌아오지 않으면 드래그가 끝나지 않는다.** 4093ee62 는 `overlay` 에 touchmove/touchend 리스너를 달았다. iOS 는 터치 이벤트를 "처음 터치한 요소"로 보내는데, 드래그 중 리렌더·스크롤 등으로 그 요소가 DOM 에서 빠지거나 시스템이 touchend 를 주지 않으면(시스템 제스처 개입 등) `phase` 가 `dragging` 으로 영구히 남고 `transform: translateY(Npx)`·딤이 그대로 남는다 → 시트가 중간에 멈추고 이후 터치도 무시된다. | **재현됨(Chromium)**: touchend 를 끝내 주지 않으면 수정 전 시트가 `translateY(84px)`·딤 `rgba(0,0,0,.36)` 로 영구히 남는다(`before/B-2-after-lost-touchend.png`). 실기기에서 어떤 경로로 touchend 를 잃는지는 실기기 확인 필요 |
| 2 | **빠른 아래 플릭이 닫히지 않는다**(거리 35% 기준만 있고 속도 기준 없음). 짧고 빠른 동작은 원위치로 돌아가 "부자연스럽다/닫힘이 일관되지 않다"로 보인다. | 재현됨(Chromium, `before` 2번) |
| 3 | **iOS WKWebView 문서 자체의 rubber-band.** `SceneDelegate` 가 `bounces=true`·`alwaysBounceVertical=true` 로 문서 전체가 항상 튕긴다(앱 전역 의도). 웹 `touchmove.preventDefault()` 는 iOS 에서 **스크롤이 시작되기 전 첫 touchmove 에서만** 효과가 있고, 이후는 `cancelable=false` 라 막을 수 없다. 인식 임계(3px) 안쪽 첫 이동은 취소하지 않으므로 손가락 속도·시작 위치에 따라 어떤 때는 막히고 어떤 때는 문서가 튕겨 그 아래 WebView 배경(흰색)이 드러난다 = **같은 동작인데 일관성이 없는 이유**로 가장 유력. | **Chromium 에서는 재현 불가**(네이티브 바운스 없음). 코드·iOS 동작 분석이며 실기기 확인 전에는 확정하지 않음. 웹만으로는 항상 막을 수 없다고 판단해 네이티브 보완을 추가 |
| 4 | 드래그마다 `getBoundingClientRect()`(레이아웃 읽기)로 딤 투명도를 계산, 열 때 `visualViewport` 변화에 오버레이 top/height 를 그대로 따라가 바운스·주소창 변화 순간 오버레이가 화면 아래에서 떨어질 수 있음. | 코드 분석 |
| 5 | snap-back(복귀 애니메이션) 중에는 새 터치를 무시 → 빠른 연속 드래그가 먹통. | 코드 분석 + 단위 테스트 |

## 수정
**웹 (lib/sheetDrag.ts, SheetOverlay.tsx, globals.css)**
- 드래그 이벤트를 touchstart 이후 **window** 에서 받는다(요소가 사라져도 touchend 수신). 터치 id 추적, 다른 손가락은 무시.
- 복구 장치: `touchcancel`·창 blur·pagehide·visibility hidden·**정지 2.5초 타임아웃**·새 터치 시작 시 끝나지 않은 드래그 → 시트를 원위치로 복구(중간 위치에 남지 않음).
- 부드러움: 드래그 시작 때 높이를 1회만 측정(move 마다 레이아웃 읽기 제거), `transform`(+`will-change`)만 갱신, 손가락 이동을 같은 프레임에 즉시 반영(점프 없음), 드래그 중 본문 `overflow-y:hidden` 잠금으로 네이티브 스크롤/바운스와 동시 발생 방지, 감속 곡선 `cubic-bezier(.32,.72,0,1)`, 닫힘 시간은 남은 거리/속도(140~220ms), 딤도 같은 곡선으로 해제.
- 닫기 기준: 거리 35% **또는 아래 방향 플릭**(≥0.5px/ms, 최소 32px). 느리고 짧은 드래그는 원위치(민감도 증가 없음). 버튼·링크·입력 요소·가로 스와이프·다중 터치는 드래그로 전환하지 않음.
- snap-back 중 다시 잡으면 현재 위치에서 이어서 따라감(점프 없음).
- 바운스: 시트 밖 touchmove·스크롤 끝단 초과 touchmove `preventDefault`(유지·보강), `html.sheet-no-bounce{overscroll-behavior:none}`, contentDrag 시트는 키보드가 올라올 때만 visualViewport 보정.
- 실기기 진단: `localStorage.mwhabit_sheet_debug="1"` 이면 `window.__sheetDragLog` 에 단계 기록(기본 꺼짐).

**네이티브 (iOS, 최소 범위)** — 기존 `NavigationPolicy` 플러그인에 `setVerticalBounceEnabled` 추가(새 플러그인 없음). 시트가 열린 동안만 `scrollView.bounces`/`alwaysBounceVertical` 를 끄고 끄기 직전 값을 저장했다가 복원. 복원 조건: 웹이 닫음/언마운트 신호 · 새 문서 로드 시작(`isLoading` KVO) · 앱 비활성화(+ 웹이 다시 보일 때 시트가 열려 있으면 재적용). 앱 전역 `bounces=true` 는 그대로(소스 계약 테스트가 `=false` 고정을 금지). 웹은 `lib/nativeBounce.ts` 가 호출(보유 카운트, iOS 전용, 메서드가 없는 구버전·Android·웹은 no-op).

## 한계(명확히)
- **네이티브 바운스 차단의 실효과와 "흰 레터박스 완전 해결"은 실기기 확인 전에는 확정할 수 없다(BLOCKED).** Chromium 은 iOS 네이티브 바운스를 재현하지 못한다. 네이티브 메서드는 TestFlight 1.0.3 (11) 에 없으므로 **새 iOS 빌드(예: 1.0.3 (12))가 필요**하다. 웹 수정(#1·#2·#4·#5)은 웹 배포만으로 현재 앱에도 적용된다.
- 실기기에서 여전히 문서가 튕기면 `mwhabit_sheet_debug` 로그(`__sheetDragLog`)와 `touchmove not cancelable` 기록으로 원인 구간을 좁힐 수 있다.

## 검증 요약
격리 브라우저(실제 touch, CDP) `tests/qa/sheetDrag/stress.mjs`: **수정 전 22 PASS / 4 FAIL**(플릭 미닫힘·touchend 소실 시 중간 정지·바운스 배선·html 보호 클래스) → **수정 후 26 PASS / 0 FAIL / 1 BLOCKED(실기기)**. 회귀: `sheetDrag/suite` 15, uxIntegration 61 PASS(+1 BLOCKED), backLoop 14(+2 BLOCKED), 심사경로 27/27. 단위: `sheetContentDrag` 22 · `iosVerticalBounce` 9(swiftc 순수 로직 포함) · 기존 `sheetDrag.controller`·정적 계약. iOS Debug/Release 시뮬레이터 빌드 PASS.
