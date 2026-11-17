# 결제 ↔ 센터 뒤로가기 무한 반복 — 원인 분석 (2026-11-11, 운영 eca9e24f)

## 재현 (격리 브라우저, 수정 전 eca9e24f)
`tests/qa/backLoop/repro.mjs`: 홈 → 판매 상품 → 센터(시트) → 결제 에서 헤더 ‹ 를 반복해 누른다.
```
결제: /checkout   [history.length=5]
‹ 1: /center/<UX> [history.length=6]   ← 새 entry 가 push 됨(뒤로가기가 아니라 "전진")
‹ 2: /checkout    [history.length=6]   ← 센터의 ‹ = router.back() → 방금 떠난 결제 entry 로 pop
‹ 3: /center/<UX> [history.length=6]
‹ 4: /checkout    …  (무한 반복, 홈에 도달하지 못함)
```
## 원인
1. 결제 화면 헤더 ‹ 는 `<a className="side" href={centerBackHref}>`(app/checkout/page.tsx 3곳) — **고정 경로 링크**라 "뒤로가기"가 아니라 센터 상세로의 **새 이동(history push)** 이다. [홈, 센터, 결제] → [홈, 센터, 결제, **센터'**].
2. 센터 상세의 ‹ 는 `BackButton`(→ `navigateBack` → `router.back()`): 앱 안 이동 이력이 있으면 직전 entry 로 pop → 방금 push 된 센터' 의 직전 = **결제**. 결제 ‹ 는 다시 센터를 push … 두 화면을 왕복한다.
3. iOS 왼쪽 가장자리 스와이프·Android back 도 `findBackControl()` 로 이 같은 `<a>` 를 눌러(lib/backPolicy.ts) 동일하게 반복 — 네이티브/Android 문제가 아니라 웹 링크의 의미(push vs pop) 문제다.
4. (NICEPAY 경로) 결제창 종료 안내의 '결제 화면으로 돌아가기'는 `location.replace(결제경로)` 로 **결제창 안에서 쌓인 entry(gwPayment·smartPayment 등) 뒤에** 결제 화면을 놓는다 — 이후 ‹ (router.back)는 센터가 아니라 NICEPAY 페이지 entry 로 간다. 반복할 때마다 entry 가 더 쌓인다.
## 영향 범위
고정 `href` 로 "뒤로"를 구현한 화면 61개 중, 목적지가 **자신의 ‹ 가 router.back() 인 화면**인 쌍은 결제→센터뿐이다(나머지 목적지는 /, /mypage, /admin, /manager 같은 root 탭이라 ‹ 가 없어 반복이 생기지 않는다).

## 추가로 확인된 원인 (수정 중 발견)
5. 구매 시트의 "구매"는 `window.location.href = /checkout…` 로 **전체 문서 로드**였다. 새 문서가 되면 앱 안 이동 기록(`lib/appHistory.ts` 메모리·sessionStorage trail)이 끊겨, 결제에서 ‹ 로 돌아온 센터의 ‹ 가 실제 직전 화면(검색·판매 상품) 대신 홈 폴백으로 갔다(검색 → 센터 → 결제 후 ‹‹ 가 검색이 아닌 홈).
6. 되돌아갈 앱 안 화면이 없는 첫 진입(딥링크)에서 ‹ 의 폴백이 `router.push` 라 [결제, 센터] 두 entry 가 생겨 센터 ‹(router.back) ↔ 결제 ‹ 왕복이 딥링크에서도 재현될 수 있었다.

## 수정
| 변경 | 이유 |
|---|---|
| `app/checkout/page.tsx` 헤더 ‹ 3곳 `<a href>` → `<BackButton fallbackHref>` | "뒤로"를 push 가 아닌 pop(router.back)으로. 폴백은 이력이 없을 때만 |
| `app/center/[id]/page.tsx` `handlePurchase` `window.location.href` → `router.push`, 조회 전용 "결제 화면 확인" `<a>` → `<Link>` | SPA 이동으로 이동 기록 유지 |
| `lib/backPolicy.ts` `navigateBack` 폴백을 `router.replace` + `lib/appHistory.ts` `noteReplaceNavigation` | 딥링크에서 폴백이 새 entry 를 만들지 않고, 대체 이동은 "앱 안 이력"으로 세지 않음 |
| `lib/payments/reviewHistory.ts`(신규)·`NicepayReviewWindow.tsx`·`reviewReturnPage.ts` | NICEPAY 결제창 안에서 쌓인 entry 를 건너뛰고 열기 직전 결제 entry 로 `history.go(-n)` 복귀(새 entry 없음, 반복해도 일정). 값 검증 실패 시 기존 `location.replace` 폴백 |
네이티브(iOS/Android) 코드 변경 없음 — 웹 배포만으로 반영된다.

## 수정 전/후 history 흐름 (홈 → 판매 상품 → 센터 → 결제)
- 전: `[홈, 상품, 센터, 결제]` → ‹ → `[홈, 상품, 센터, 결제, **센터'**]`(push) → ‹ → 결제(pop) → ‹ → 센터'(push)… 무한.
- 후: `[홈, 상품, 센터, 결제]` → ‹ → 센터(pop, 길이 동일) → ‹ → 상품(pop) → ‹ → 홈.
- NICEPAY: 전 `[…, 결제, gwPayment, smartPayment, 종료안내→replace→결제']`(‹ → smartPayment), 후 종료 안내에서 `history.go(-n)` → 원래 `결제` entry(‹ → 센터), 3회 반복해도 길이 일정.

## 남은 위험
- 고정 `href` ‹ 링크 화면 58개(root 탭·관리자/매니저 홈으로 가는 링크)는 push 로 entry 를 하나 더 만들지만, 목적지가 root(‹ 없음)라 왕복 루프는 없다(`docs/TODO.md` P2).
- NICEPAY entry 되돌아가기(`history.go`)는 Chromium 에서 검증(격리 브라우저). iOS WKWebView 실제 결제창의 entry 수·bfcache 복원은 **실기기 확인 필요(BLOCKED)**. 길이/값 검증이 어긋나면 기존 replace 폴백.

## 검증 결과 (격리 DB 브라우저, `tests/qa/backLoop/suite.mjs`)
14 PASS · 2 BLOCKED(T8 가로 스크롤 영역 없음/T9 실기기 네이티브). T1 홈→상품→센터→결제 ‹‹‹, T2 검색→센터→결제 ‹‹(검색어 보존), T3 ‹ == 브라우저 back·중복 방문, T4 딥링크(결제/센터/브리지), T5 시트 back, T6 NICEPAY 종료→복귀→‹‹, T7 3회 반복(길이 일정)·‹‹‹, T8b 가장자리 터치 스와이프(웹 계층). 회귀: `uxIntegration` 4종 61 PASS·1 BLOCKED, 심사경로 27/27. 단위 `tests/unit/backLoop.test.ts` 19건.
