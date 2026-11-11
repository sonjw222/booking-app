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
