# 성능/iOS 체감 감사 (2026-10-02)

실제 코드 근거가 확인된 항목만 기록한다. 기준 commit 0d787b5(Universal Link 통합 브랜치).

## 측정 근거(검색 결과)
- 내부 same-origin `<a href="/…">` 228곳(전체 페이지 리로드). 상위: app/manager/page.tsx 30, ManagerNav 20, app/mypage 17, app/page.tsx 14.
- `window.location.*` 사용: login/OAuth callback/SessionWatcher/CapacitorBootstrap/결제 callback 등(의도적 full navigation).
- `<Link>`는 BottomNav 11(replace)·ManagerNav 8 등 탭 일부만.
- `app/layout.tsx`가 모든 화면에서 `https://js.tosspayments.com/v2/standard`를 afterInteractive로 로드.
- `<img>` 12곳 중 `loading="lazy"`/`decoding="async"` 0곳.
- ManagerNav는 `[pathname]` 의존 effect로 이동 때마다 `fetchMyCenters` + 권한 조회를 반복.
- BottomNav/ManagerNav/SheetOverlay가 visualViewport resize·scroll마다 즉시 setState/DOM 쓰기.

## P0
1. **전체 리로드(228곳)** — 화면 이동마다 문서·JS 재실행, CapacitorBootstrap/SessionWatcher/테마 스크립트 재실행. → 수정(분류 A만 Link 전환, 아래).
2. **Toss SDK 전역 로드** — 결제와 무관한 모든 화면에서 외부 JS 다운로드·파싱. → 수정(온디맨드 로더).

## P1
3. ManagerNav 권한 재조회가 이동마다 반복 → 60초 TTL + visibilitychange 재확인으로 축소(RLS는 그대로).
4. 키보드 감지 burst setState/DOM 쓰기 → rAF 합치기 + 값 동일 시 skip(BottomNav/ManagerNav/SheetOverlay).
5. 목록 썸네일 `<img>` 즉시 로드 → lazy + async decode(ImageViewer 활성 이미지 제외).

## P2 (이번에 바꾸지 않음 / TODO)
- app/globals.css:5341·5360·5370·6336 태블릿 rail의 width/max-width/padding transition — 의도된 확장 애니메이션이며 768–1359px 터치 태블릿에만 적용. 모바일 iPhone 경로 아님. transform 전환은 레이아웃 재설계가 필요해 보류.
- app/globals.css:3166 알림 행 삭제 max-height transition — 1회성, 행 수 적음.
- 긴 목록: manager 회원/수업 목록은 이미 visibleCount/페이지 단위 로딩을 사용(전수 DOM 수백 개 사례는 확인되지 않음) → content-visibility 적용 보류.
- sheetDrag / SwipeRow / useExpandableNavRail: pointermove에서 React state를 매 프레임 바꾸지 않음(DOM transform/CSS 변수 또는 결정 시 1회 setState) → 변경 없음.

## 전체 리로드 분류(228곳)
- A(Link 전환, prefetch={false}): 같은 영역 안의 내부 이동 — /manager/* 안의 /manager 링크, /admin 안의 /admin 링크, 회원 영역의 회원 경로 링크. 184곳.
- B/F 유지(전환 안 함): onClick 핸들러가 있는 링크 14곳(replaceTabNavigation 등 기존 이동 로직), 영역을 넘는 이동(회원↔관리자↔운영자 모드 전환), /login, /account-deletion 등.
- C/D/E 유지: 외부 URL, OAuth·로그인 callback, Toss 결제·Universal Link callback, SessionWatcher(세션 리셋) — app/checkout/**, app/login/**, SessionWatcher, CapacitorBootstrap은 변환 대상에서 제외.
- prefetch: 카드·사이드바 링크가 많아(관리자 홈 30, 사이드바 20) 자동 prefetch가 네트워크를 폭증시키므로 전부 `prefetch={false}`. 기존 BottomNav 탭 Link(replace)는 그대로.
