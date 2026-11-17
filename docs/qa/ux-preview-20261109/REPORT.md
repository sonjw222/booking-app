# UX 통합 브랜치 Vercel Preview 브라우저 QA (2026-11-09)

- 브랜치/커밋: `feat/app-ux-navigation-20261109` @ `cb510214` (`git archive` 로 만든 깨끗한 사본을 배포 — 로컬 untracked `GoogleService-Info.plist`·ios·android 는 올리지 않음)
- Preview: https://booking-fkzxqbufx-sonjw.vercel.app · 배포 ID `dpl_3ZiHrzxZ8hAS28SJegCEPkCvY9Pj` · target=preview · READY. Production 배포·도메인 변경 없음.
- 방법: Vercel CLI 로 Preview 만 배포 → 배포 보호(Vercel Authentication)는 `vercel curl` 이 발급한 임시 `_vercel_jwt` 쿠키로 통과 → Playwright(Chromium). **로그인하지 않고 읽기 전용**(공개 페이지, 주문·결제·예약·쿠폰·발급 없음). 비밀번호·키 미사용.
- Preview 환경: Supabase 는 Production 과 다른 호스팅 DB(P3 격리 테스트 센터 2곳, 수업 0개, 횟수 선택형 상품 없음 — 값은 출력하지 않음), `NEXT_PUBLIC_PG_CHECKOUT_ENABLED=false`, NICEPAY 심사 창 환경변수(`NICEPAY_REVIEW_*`)·서비스 롤 키 없음 → 결제 OFF.

| ID | 항목 | 결과 |
|---|---|---|
| A1~A3 | 종료 화면: 확인 불가 문구, 성공 표현 없음, CSP(script-src 해시), 마이페이지 링크 없음, 폴백 '홈으로 돌아가기' | PASS |
| A4~A5 | 저장된 결제 경로 → '결제 화면으로 돌아가기', 센터·상품·횟수·사이즈 유지 | PASS |
| A6 | 외부 URL / 토큰 키 / 스크립트 값 / 만료 / 깨진 JSON / 미래 시각 → 안전 폴백 | PASS (6건) |
| A7~A10 | 클릭 → 해당 결제 화면 URL 이동, 저장 값 삭제, NICEPAY SDK·goPay·review-window POST 없음, 뒤로가기로 종료 화면 재진입 없음 | PASS |
| A11 | CSP 위반 콘솔 오류 없음 | PASS |
| A12 | 서명된 시도(rt)로 열린 실제 X 종료 → 센터 상세 폴백 / 외부 NICEPAY 창 | **BLOCKED** (Preview 에 심사 창 환경변수·심사 계정 없음, 외부 결제창은 금지 범위) |
| B | 시트: 360/390/430/1024px × 센터 2곳 — 가로 넘침 없음, 횟수 드롭다운 0, 버튼 높이 44px, 담기/구매 같은 위치 | PASS (각 4×2) |
| B | 시트 '○원부터' 요약·'횟수는 결제 화면에서' 안내, 가격표 횟수 제한, 쿠폰·포인트 재계산, 사이즈 필수, 장바구니 담기·구매 | **BLOCKED** (Preview 데이터에 횟수 선택형/사이즈 상품 없음, 로그인 필요) — 단위 테스트로 검증 |
| C | 센터 수업 탭·수업 상세·예약 허용 수강권 이름 병합, class_id 조회, 조회 실패 표시 | **BLOCKED** (Preview 센터에 수업 0개) — `passNameDisplay` 단위 테스트로 검증 |
| D1 | 시트 열림 + back(`__mwhabitBack`) → `close-overlay`, 배경 이동 없음; '닫기' 버튼 → 시트만 닫힘 | PASS |
| D2 | 딥링크 첫 진입 ‹ → `/` | PASS |
| D3~D4 | 앱 안 이동 후 ‹ → 이전 화면, root(홈)에는 ‹ 없음 | PASS |
| D5 | 문서 가로 넘침 없음(칩/캐러셀 요소는 홈에서 찾지 못해 실제 스와이프는 미검증) | 부분 PASS |
| D6 | 변경사항 버리기 확인창(alertdialog) back 무시 | **BLOCKED** (매니저 로그인 필요) — `backPolicy` 단위 테스트로 검증 |
| D7 | iOS 왼쪽 가장자리 제스처·오른쪽 앞으로 차단·시뮬레이터/실기기 | **BLOCKED** (실기기 QA) |

스크린샷: `docs/qa/ux-preview-20261109/screenshots/` (sheet-{360,390,430,1024}-c{1,2}.png, return-fallback-390.png, return-to-checkout-390.png)
