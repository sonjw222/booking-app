# TypeScript·ESLint 기술 부채 정리 (2026-11-17)

## 수치 (main 기준)
| 항목 | 전 | 후 |
|---|---|---|
| `tsc --noEmit` | 63 (전부 tests/) | **0** |
| ESLint 에러 | 1,481 | **163** (app 148 · lib 6 · scripts 9) |
| ESLint 경고 | 196 | **28** |
| `no-explicit-any` | 1,282 | 26 |
| Vitest | 3,310 통과/10 skip | 동일 |

PR: #267 baseline 재생성 스크립트 · #268 TS 63→0 · #269 tests/unit · #270 tests/integration·qa·e2e 등 · #271 lib/scripts/supabase · #272 app. 모두 CI 통과 후 merge-commit 병합, 병합마다 Vercel 운영 Ready·200·결제 prepare 503(OFF) 확인. SQL·RLS·환경변수·결제 활성화 없음.

## 원칙
숨기기 금지: `@ts-ignore`/`@ts-nocheck`/eslint-disable 추가 없음(기존 `@ts-nocheck` 2건 제거), 규칙·설정 축소 없음, 테스트 삭제·skip 없음. 단언 변경은 약화하지 않음. `scripts/lint/updateBaseline.mjs` 는 키 순서를 보존해 diff 를 최소화하며 에러 증가 시 CI(`npm run lint`)가 실패.

## 주요 패턴
- 테스트: 좁은 `interface`·`vi.fn<…>` 제네릭·`unknown`·`tests/helpers/errorMessage.ts`·`tests/qa/fixtures/rows.ts`.
- lib: 임베드 행 모양을 로컬 interface 로 선언(`lib/embed.ts`, `lib/objectUtil.ts` 타입 전용 헬퍼), `catch (e)` + 좁은 단언.
- app: `errMsg(e)`(`app/components/errorMessage.ts`), 렌더 중 ref 대입 → `useLayoutEffect`(SwipeRow·useExpandableNavRail·manager/members), 엔티티화, 미사용 코드 제거, 링크 2건 `<Link>`.
- 런타임 차이(app): `e.message ?? "폴백"` → `errMsg(e) || "폴백"`(빈 문자열도 폴백), "undefined" 표시 → 빈 문자열.

## 남은 부채 (규칙·파일·사유·건수)
- `react-hooks/set-state-in-effect` 88: app/manager/* 등 `useEffect(()=>{load()},[load])`(~40)·`if (isOwner){setMyPerms(null);return}`(~17) 등 — fetch 흐름 재설계 필요, 일괄 안전 수정 불가 → 별도 Issue.
- `react/no-unescaped-entities` 24: terms/privacy — `publicStorefront.test.ts` 가 원문 문자열 단언 → 테스트와 함께 수정.
- `no-explicit-any` 26: app 20(subscription 6·calendar 3·MapPicker 10·login 1, 소스 문자열 단언 테스트) + lib 6(center/orders/reservations×2/classes + `Notification.data`).
- `no-html-link-for-pages` 11: back-header·`replaceTabNavigation` 연동 의도(전체 문서 이동).
- `rules-of-hooks` 2: checkout `usePoints` 오탐(별칭 import 시 `orderPointLifecycle.test.ts:249` 갱신 필요).
- `purity` 1·`preserve-manual-memoization` 1: my-reservations 의도된 `Date.now()`. `refs` 1: notifications 오탐.
- `no-require-imports` 9: `scripts/qa/ui-polish/*.cjs`(의도적 CJS; ESM 변환 필요).
- 경고: `exhaustive-deps` 13(재요청/무한 렌더 위험), `no-img-element` 11, `jsx-a11y` 3, unused-vars 1.

## GitHub 정리 결과 (Track A)
- #264: #265 와 완전 중복 → 증거 코멘트 후 닫음.
- Draft 유지: #254(병합 충돌·미병합 런타임 변경), #260(문서 전용·CI 오래됨), #263(법적 문구 승인 필요) — 분류 코멘트.
- Issue 7건: 완료 증거 불충분 → 종료 없음, 코멘트(+`needs-review` #262, `blocked` #255).

## Graphify
파일 추가는 `lib/embed.ts`·`lib/objectUtil.ts`·`app/components/errorMessage.ts`·`tests/helpers/errorMessage.ts`·`tests/qa/fixtures/rows.ts`·`scripts/lint/updateBaseline.mjs` 뿐이고 모듈 구조 변경은 작아 즉시 갱신 불필요. 원하면 `graphify update .`(LLM 미사용).
