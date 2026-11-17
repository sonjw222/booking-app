# 운영 배포 dpl_A9qK… 출처 확인과 수강권 안내창 개선 통합 (2026-11-16)

## 운영 배포 출처
- Vercel 메타데이터(`vercel api /v13/deployments/dpl_A9qKXh6tgptX2dsUNjmR8RCoAp5C`): source=cli, 생성 2026-11-16 15:10 KST, meta `commitSha=33bc408c8b31babddd0d78c84760b0aa2e70f92c`, `reviewScope=subscription-hosted-only`, `actor=codex`.
- 커밋 33bc408c = 브랜치 `feat/nicepay-subscription-production-review-20261116`(Codex 작업 디렉터리 `~/.codex/.chatgpt-projects/…/nicepay-subscription-production-20261116`, 로컬 전용 — GitHub/이 저장소 미존재)의 "feat(nicepay): isolate hosted subscription review on current production base" (4093ee62 위 21파일: 정기결제 호스티드 등록 심사 라우트·`NicepaySubscriptionReview`·매니저 구독 심사 페이지·`billing.ts` 1줄·테스트). 이후 커밋 04599af·1d16191·3fc09b1 은 docs 만(비-docs 파일 0).
- **소스 일치 검증**: `GET /v6/deployments/{id}/files` 의 파일별 sha1 과 `git archive 33bc408c` 대조 → 배포 1607개 파일 **전부 내용 동일, 배포에만 있는 파일 0, 다른 파일 0**. 커밋에만 있고 배포에 없는 파일은 docs·ios·android·supabase·dev tooling·.gitignore(업로드 제외 대상)뿐, app/lib/public/설정 파일 누락 0.

## checkout/cart 청크 차이의 정체
33bc408c 는 `app/checkout`·`app/cart`·`lib/cart`·`lib/orders` 를 **수정하지 않았다**(diff 0). 차이는 빌드 산출물 차이: 새 구독 심사 코드가 `nicepayV3Window` 등 공용 모듈을 함께 import 하면서 Turbopack 이 모듈을 분리(`e.i(20218)`, `e.i(86683)` 등)하고 변수명이 재배치됨. 청크 diff 에서 로직 변경 없음(동일 함수 호출, 이름만 변경).

## 통합
`integration/product-sheet-bounce-production-20261116` = 운영 소스 브랜치 `3fc09b1b`(= 33bc408c + docs) 위에 `1ceb953b`(수강권 안내창 드래그·네이티브 바운스 연동)와 `7b0ee3f9`(Build 12) cherry-pick — 충돌 없음. 운영 소스 대비 앱 코드 diff 는 `lib/sheetDrag.ts`, `lib/nativeBounce.ts`, `app/components/SheetOverlay.tsx`, `app/globals.css` 4개뿐(+네이티브 2파일·테스트·docs). checkout/cart/구독 심사 코드 변경 없음.
