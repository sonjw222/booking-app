# 기능 회귀 QA — main `527fe07e` (2026-11-17)

대상: ESLint·TypeScript 정리(#267~#273) 병합 직후 main. 비교 기준: 정리 직전 `58026928`(같은 환경에서 빌드).
환경: 격리 로컬 Supabase `mwhabit-reviewpath`(포트 547xx, 공유 `mwhabit-isolated`·:3100·터널 미접촉) + `next build`/`next start`(3216) + https 프록시(3217). 실제 mwhabit.com·운영 DB·실제 결제/주문/예약 없음(외부 호스트 전부 차단, QA 전후 orders/payments 0/0). NICEPAY SDK 는 stub, 심사 서버 설정은 무작위 모의 키(`NICEPAY_REVIEW_WINDOW_ENABLED=true`, `NICEPAY_CHECKOUT_ENABLED=false`).
시험 데이터: `bootstrapEphemeral` + `setupLocal/ExtraPersonas/RealCenter` + `localUxFixture.sql` + 심사관 모의 계정(서버가 고정한 UID·이메일로 격리 스택에만 생성, 비밀번호 무작위·미기록)·`A10TION 피겨팀`(=실센터 모사 개명)·조회 전용 허용 1행.

## 결과 요약
| 구분 | 스위트 | 결과 |
|---|---|---|
| 화면·내비·시트·장바구니·결제 | `uxIntegration/sheetCheckout` | **41 PASS** |
| | `classPasses` | **6 PASS** |
| | `backPolicy` | 6 PASS · 1 BLOCKED(실기기) |
| 수강권 안내창 | `sheetDrag/suite` | 15 PASS · 1 BLOCKED(iOS 실제 rubber-band) |
| | `sheetDrag/stress`(드래그·바운스 배선·정상 종료 불변식) | 26 PASS · 1 BLOCKED(iOS 네이티브 실효과) |
| NICEPAY 심사 창·복귀 | `uxIntegration/returnFlow`(결제창 확인→X 종료→결제 화면 복귀) | **8 PASS** |
| | `reviewPath/browserQa`(심사 경로 27항목) | **27 PASS** |
| 뒤로가기(결제↔센터) | `backLoop/suite` | 14 PASS · 2 BLOCKED(실기기) |
| ESLint 수정 영향 + 스모크 | `regression20261117/impact` | 아래 |
| 단위·계약(iOS 바운스/가장자리 back/NICEPAY 안전영역·네비 포함) | Vitest 전체 | **3,310 PASS**/10 skip, 신규 실패 0 |
| 새 오류 | tsc 0, `npm run lint` 새 에러 0, `next build` 성공 | PASS |

### ESLint 수정 영향(`impact.mjs`, 최종 실행 `logs/impact3.log`)
- **PASS** 화면 스모크: 매니저 24개 화면·비로그인 6개 화면 5xx/오류경계/pageerror 0. 회원 19/20(아래 `/settings` 제외).
- **PASS L1·L2** `<Link>` 전환: 로그인 로고·결제(없는 상품) "홈으로" → 문서 재로드 없는 소프트 내비게이션.
- **PASS E1·E2** `errMsg`: 잘못된 비밀번호 → 오류 문구 표시(빈 문구·undefined 아님), 조회 500 → 크래시 없이 화면 유지.
- **PASS M1·M2** `filtersRef`(`useLayoutEffect`): 회원 검색 즉시 필터·복원, 새로고침 후 정상.
- **PASS W1–W4** `SwipeRow` cfg ref: 열림 스냅(-88px)·다른 행 열면 이전 행 닫힘·반대로 밀면 닫힘·스와이프만으로 삭제 없음.
- **PASS N1·N2** `useExpandableNavRail` expandedRef: 태블릿 폭 매니저 nav 펼침/접힘·메뉴 이동 시 compact 복귀. (시험 보정: 펼침 상태는 `aria-expanded` 로 노출, 제스처는 합성 PointerEvent(touch)로 구동 — CDP 터치는 브라우저 제스처 판정으로 `pointercancel` 됨. 시험 방식 문제였고 앱 회귀 아님.)
- **FAIL(기존 결함, 회귀 아님)** `X-pageerror`/`S-member`: 로그인 상태에서 **존재하지 않는 회원 경로**(예 `/settings`, `/mypage/zzz` — 404)를 열면 `Minified React error #418`(하이드레이션 불일치). **정리 직전 `58026928` 에서도 동일**(`logs/impact_base.log`) → 이번 변경과 무관. 비로그인 404(`/definitely-not-a-route`)는 정상. 후속: docs/TODO.md P3.

## BLOCKED(실기기·네이티브 전용 — 코드 변경 없음)
iOS WKWebView 실제 rubber-band·가장자리 제스처·오른쪽 앞으로 차단, Android 시스템 back, 카드사 앱 실복귀, 소셜 로그인 실동작. `ios/`·`android/`·`capacitor.config.ts` 는 이번 정리 PR 에서 **변경 0 파일**(`git diff e1ec72dc 527fe07e`), 계약 단위 테스트는 전부 통과.

## 시험 과정 메모(원인 분석)
- 심사 경로 스위트가 처음 FAIL/타임아웃: 앱이 심사 계정을 **고정 UID·이메일**로만 인정하고 서버 설정(`NICEPAY_REVIEW_*`, `NEXT_PUBLIC_PG_CHECKOUT_ENABLED=false` 는 빌드 시 반영)이 필요했음 → 환경 구성 문제였고 모의 계정·설정 추가 후 전부 PASS.
- 정리 직전 빌드와 현재 빌드에서 `impact.mjs` 결과 동일(회귀 0).

## 파일
- `tests/qa/regression20261117/impact.mjs` — ESLint 수정 영향·스모크 시험(격리 스택 전용, 재실행 방법은 파일 머리 주석).
- `docs/qa/regression-20261117/logs/*` — 스위트별 결과 로그 10개(인증정보·토큰·쿠키·이메일 없음 확인, 합계 약 56KB). 스크린샷·DB 덤프는 포함하지 않음.
- 참고: `logs/impact_base.log` 는 정리 직전 빌드(`58026928`)에서 **시험 스크립트 첫 버전**으로 돌린 로그라 N1/N2 FAIL 은 시험 방식 문제(보정 전)이며, 근거로 쓰는 것은 `/settings` 404·#418 이 정리 전에도 동일하다는 점이다. 보정 후 N1/N2 는 `impact3.log`(정리 후)에서 PASS.
- 앱 코드·SQL·설정 변경 없음.
- 기존 결함 Issue: #275 (로그인 상태 404 화면 React #418, P3).
