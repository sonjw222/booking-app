# 수강권 안내창 닫기 제스처·오버스크롤 (2026-11-16, 기준 Production 132ec548)

## 원인
1. **왼쪽 가장자리 스와이프로 시트가 닫힘**: iOS 네이티브 `EdgeBackGesture` → `window.__mwhabitBack()` → `runBack()`(lib/backPolicy.ts)이 "열린 오버레이를 먼저 닫는다(close-overlay)"는 단일 back 정책으로 처리. 이전 UX 정책(오버레이 우선)이 edge 스와이프에도 그대로 적용된 것. Android 시스템 back 도 같은 입구를 쓴다.
2. **흰 빈 영역**: `ios/App/App/SceneDelegate.swift` 가 `scrollView.bounces = true`, `alwaysBounceVertical = true` 로 WebView **문서 전체**가 항상 rubber-band 한다(앱 전역 의도, 실기기 QA 항목). 시트는 `overscroll-behavior: contain` 과 `body{overflow:hidden}` 이 있지만 (a) 시트 밖(딤 영역) 터치, (b) 시트 본문이 맨 위/맨 아래에서 더 밀릴 때의 터치는 네이티브 scrollView 바운스로 이어져 페이지(시트 포함)가 통째로 끌려 내려가 그 아래 WebView 배경(흰색)이 드러난다. 시트 드래그 닫기는 **핸들에서 시작한 제스처만** 인정해서(`lib/sheetDrag.ts` 정책) 본문을 당기면 닫히지 않고 바운스만 일어났다.
   - Chromium 에서는 iOS 네이티브 바운스를 재현할 수 없다 → 원인은 코드·iOS 동작 분석 기준이며 실제 효과는 실기기 확인 필요(BLOCKED).

## 수정 (웹 코드만 — 네이티브 변경 없음)
| 항목 | 방식 |
|---|---|
| 가장자리 스와이프로 닫힘 제거 | `SheetOverlay` 가 opt-in(`contentDrag`) 시트에 `data-edge-swipe-block` 표시. `runBack(…, {edgeSwipe:true})` 는 그 시트가 맨 위면 `"blocked-by-overlay"` 를 반환하고 아무것도 하지 않는다(시트 유지·뒤 화면 이동 없음). iOS 네이티브 앱에서는 `__mwhabitBack`(이미 배포된 네이티브가 호출하는 이름)이 edge 판정을 가리키도록 `NavigationPolicy` 가 `Capacitor.getPlatform()==="ios"` 일 때 연결. 네이티브는 문자열 결과면 이미 아무것도 하지 않는다(`EdgeBackPolicy`). Android 시스템 back·‹·다른 시트는 기존 정책 유지. |
| 아래로 드래그 닫기 | 기존 핸들 드래그(포인터) 유지 + 수강권 안내창에만 본문 터치 드래그 추가(`attachSheetDrag({contentDrag})`): 본문이 맨 위(scrollTop 0)에서 아래로 시작한 세로 제스처만 드래그로 전환(`preventDefault`), 시트 전체가 손가락을 따라 내려가고 딤이 옅어지며, 35% 이상이면 슬라이드아웃 후 닫힘(기존 규칙 그대로, 속도 기준 없음), 미만·취소는 원위치. 본문이 맨 위가 아니면 스크롤 우선, 가로 제스처·입력 요소·핸들(포인터 경로)·여러 손가락은 제외. |
| 흰 영역 차단 | 같은 opt-in 시트에서 시트 밖 터치 이동과 스크롤 끝단 초과 터치 이동을 `preventDefault` 해 네이티브 바운스로 이어지지 않게 한다. 전역 `overflow:hidden`·다른 화면 스크롤은 변경 없음. 안전영역·하단 인디케이터 스타일 변경 없음. |
범위 제한: `contentDrag` 는 센터 구매 시트(수강권 안내창)에서만 켠다(소스 계약 테스트가 고정). 다른 시트의 드래그·back 동작은 불변.

## 검증
격리 브라우저(실제 Chromium 터치 이벤트) `tests/qa/sheetDrag/suite.mjs` — 수정 전(132ec548) FAIL: Q5(본문 드래그 닫기)·Q6·Q7/Q8(edge 입구 부재→시트 닫힘)·Q9(바운스 차단 없음); 수정 후 14 PASS · 1 BLOCKED(실기기). 회귀: uxIntegration 4종 61 PASS/1 BLOCKED, backLoop 14 PASS/2 BLOCKED, 심사경로 27/27. 단위 `tests/unit/sheetContentDrag.test.ts` 16건.
