# Issue #210 — 내 예약 취소·오류·모바일 접근성 신규 E2E

## 신규 파일
- `tests/e2e/reservation/member-cancel/my-reservations-cancel-a11y.spec.ts` — Batch A/B (실행 대상)
- `tests/e2e/reservation/member-cancel/admin-permission-separation.spec.ts` — Batch C (`test.fixme`, fixture 필요)

## 실행 (DEV Supabase `jdglfvwdnkjnraqdxuuj` 전용, `.env.test.local` 필요)
```
npx playwright test tests/e2e/member-cancel
npx playwright test tests/e2e/member-cancel -g "A1"        # 특정 그룹
```
`playwright.config.ts`의 `testDir: ./tests/e2e`에 포함되어 별도 설정 없이 선택된다(`setup` 프로젝트가 먼저 실행되어
`playwright/.auth/*.json`을 생성). QA 런너가 `scenarios: member,admin,reservation` 처럼 디렉터리/그룹명으로 스펙을 고르는
경우 `member-cancel` 경로가 그 목록에 포함되어야 실행된다 — 런너 설정은 이 이슈 범위 밖이라 변경하지 않았으며,
**연결 전까지 자동 QA에서는 "QA 미실행"** 으로 취급한다.

## 신규 검사 (기존 92개와 별개)
| 그룹 | 검사 | 현재 앱 기대 결과 |
|---|---|---|
| A1 | 200+빈 목록=빈 상태(오류 없음) | 통과 예상 |
| A1 | 400/500/503 → 오류 안내+재시도, 재시도 후 회복 | **실패 예상**(오류가 빈 목록으로 보이고 재시도 버튼 없음) |
| A2 | 복수 예약 취소 버튼 접근성 이름 구별 | **실패 예상**(모두 "취소") |
| A3 | 토스트 role/aria-live, 타이머 clearTimeout(정적) | **실패 예상** |
| A4 | 마감 후+차감 on/off, 마감 전, 10분 유예 확인창 안내 | **실패 예상**(문구 고정) |
| A4 | 수업 시작 후 취소 버튼 없음 | 통과 예상 |
| A5 | /reservation vs /my-reservations 확인창 문구 일치 | 통과 예상(둘 다 동일 고정 문구 — 단 A4 안내 추가 시 두 화면 동시 수정 필요) |
| B6~8 | 320/360/390 × light/dark: 가로 넘침, 겹침, 44×44, 대비 4.5:1 | 44×44는 CSS상 실패 가능성 있음(min-height 30px) |
| B7 | safe-area 정적 점검 | 조건부 |
| C | 비오너 직원/타센터 권한 분리 | fixme — 비오너 직원 fixture 없음, 요구사항은 스펙 상단 주석 |

## 후속 수정 대상(별도 승인 Issue)
`app/my-reservations/page.tsx`(오류 재시도, 버튼 aria-label, 토스트 role/타이머 정리, 취소 전 차감 안내),
`app/reservation/page.tsx`(동일 안내), `app/globals.css` `.hist-cancel-btn`(터치 영역).

## 미검증/한계
- 서버 시간은 속이지 않음. 확인창 이후의 실제 차감 결과는 통합 테스트(`reservation-cancel-grace-period.test.ts`) 영역.
- 대비는 불투명 색만 계산, 합성 불가 색상은 annotation "미검증".
- 실기기 safe-area/노치는 미검증.

CI 연결: reservation 하위 경로를 사용해 기존 E2E 3/4 checkpoint에서 자동 선택되며 .github 설정은 변경하지 않았다.
