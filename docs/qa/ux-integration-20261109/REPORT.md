# UX·네이티브·심사경로 통합 브랜치 QA (2026-11-09)

브랜치 `integration/ux-native-review-20261109` = `origin/main`(368aa3e1) + PR #265(`fd659321`, fast-forward) + PR #264(`a0ffc925`, merge) + UX 브랜치 `feat/app-ux-navigation-20261109` 의 `fd659321..f1727ea0`(16 커밋, cherry-pick).

## 격리 테스트 환경
- 세 번째 로컬 Supabase 스택 `mwhabit-reviewpath`(포트 오프셋 300 → 547xx), 앱 `next start`(3216) + https 프록시(3217). 운영/공유 DEV 무관, 외부 호스트 요청 0.
- 이전 실패 원인(진단): 5462x 포트가 macOS 임시(ephemeral) 포트 대역이라 다른 소켓(`172.25.78.54.54621 → …:995 CLOSE_WAIT`)이 54621 을 점유 → Colima 포워딩 실패(54621 만 HTTP 불가, 54625 는 정상 — 임시 컨테이너로 재현). `stack.sh` 에 `REVIEWPATH_PORT_OFFSET` 추가(기본 200 유지).
- 시험 데이터: `scripts/qa/uxPreview/localUxFixture.sql` — 횟수 선택형(1/4/8회, 독립 가격표), 사이즈+횟수 선택형, 사이즈 필수 고정 상품, 같은 수강권의 횟수별 변형(11월 1/4/8/12회), 다른 달(12월 4/8회), 같은 이름의 다른 수업 2개(허용 수강권 다름), 전체 허용·선택형 수업. + 기존 fixture(A10TION 모사 센터·심사 계정) 재사용.

## 결과 (Playwright, 격리 DB)
| 스크립트 | 결과 |
|---|---|
| `tests/qa/uxIntegration/sheetCheckout.mjs` — 시트 360/390/430/1024px(가로 넘침·드롭다운 0·'N원부터'·안내문·버튼 44px/같은 위치), 결제 화면 횟수=가격표(1/4/8)·실제 가격(36,000/64,000)·합계 재계산·주소 반영·잘못된 count/size 주소 차단, 사이즈 필수 막힘(주문 0건), 장바구니 담기·사이즈·횟수 저장·재담기 시 유지·새로고침 유지 | 41 PASS |
| `classPasses.mjs` — 수업 탭 병합('[UX] 11월 수강권' 1줄, 12월은 별도), 같은 이름 수업 A/B 상세가 각자 허용 수강권만, 조회 실패 시 '모든 수강권 가능' 미표시 | 6 PASS |
| `backPolicy.mjs` — 시트 열림 back→시트만 닫힘, 확인창(alertdialog, DOM 계약 모사) 우선, ‹ == 브리지 도착지, 딥링크 첫 진입 fallback, root | 6 PASS, 1 BLOCKED(실기기) |
| `returnFlow.mjs` — 심사 계정: 8회 선택→결제창 확인(stub SDK)→X 종료(ReturnURL POST)→'결제 화면으로 돌아가기'→8회 복원, 재호출 없음, 저장값 삭제, 주문·수강권 0, 직접 진입은 센터 상세 폴백 | 8 PASS |
| `tests/qa/reviewPath/browserQa.mjs`(심사 경로 27항목) | 27/27 PASS |

스크린샷: `docs/qa/ux-integration-20261109/screenshots/`, 심사경로 `review-path/screenshots/`.

## 관찰
- 센터 수업 탭은 같은 제목 수업을 한 카드로 묶고 대표(가장 빠른) 수업의 허용 수강권을 보여 준다(기존 동작). 상세 화면은 class_id 기준으로 정확하다.
- 실기기 전용(BLOCKED): iOS 가장자리 제스처·오른쪽 앞으로 차단, Android 시스템 back, 소셜 로그인 실동작, 카드사 앱 복귀.
