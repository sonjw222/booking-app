# 공유 DEV CI 잔여 수업 정리 계획 (읽기 전용 조회 결과 — 아무것도 삭제하지 않았음)

- 생성: 2026-10-26T15:21:43.816Z · 대상: 공유 DEV(mwhabit-ci-dev) · 조회 방식: GET 만
- 대상 ID 수: 23 · DB 에 존재: 23 · 전체 삭제 가능 판정: **예**
- classes.id 를 참조하는 컬럼(공유 DEV OpenAPI 기준): admin_action_logs.class_id, class_trainers.class_id, class_allowed_products.class_id, reservations.class_id, schedule_memos.class_id
- reservations.id 를 참조하는 컬럼: admin_action_logs.reservation_id, reservation_goods_usages.reservation_id
- 제외: VIEW class_reservation_counts(저장소 SQL 상 view — 행 삭제 대상 아님)
- 삭제 규칙(FK on delete)은 OpenAPI 로 알 수 없어 격리 DB 의 같은 FK 에서 확인한 값(admin_action_logs=NO ACTION, class_allowed_products/class_trainers/schedule_memos/reservation_goods_usages=CASCADE)을 참고만 하며, 실행 스크립트는 CASCADE 자식 수를 사전에 세어 계획과 다르면 중단한다.

| 수업 ID | 제목 | 생성 시각(UTC) | 예약 수 | 예약 프로필 종류 | 참조 조회 | 삭제 가능 |
|---|---|---|---|---|---|---|
| 09089778-0438-4c9c-af6f-576e81d6c43e | E2E 취소기한-실패 | 2026-10-26T09:27:29 | 0 | - | 전부 성공 | 예 |
| 156ca29c-bfaf-46a5-94a1-039bf2a685f6 | NEWCLASS-SPECIFIC-1793006468708 | 2026-10-26T09:21:14 | 1 | CI User A | 전부 성공 | 예 |
| 34a5d298-27e5-4ba9-9dcd-68e4c8bd0baa | E2E 대기인원표시 1793006627598 | 2026-10-26T09:23:47 | 1 | E2E 대기인원 임시 | 전부 성공 | 예 |
| 44920648-1629-4787-898e-fd9e34197653 | PERDAY-ATOMIC-1793006386909 | 2026-10-26T09:19:52 | 0 | - | 전부 성공 | 예 |
| 547526ae-c808-42ee-9c62-43b4fd1ea20e | NEWCLASS-BUY-1793006483165 | 2026-10-26T09:21:28 | 0 | - | 전부 성공 | 예 |
| 650538db-f67d-4348-a3b3-a55520b9f7ab | E2E-210 요가 클래스 | 2026-10-26T09:24:03 | 1 | CI User A | 전부 성공 | 예 |
| 65baba3c-075f-4771-b41e-d07736f5a3fb | NEWCLASS-GOODSCHK-1793008541828 | 2026-10-26T09:55:50 | 0 | - | 전부 성공 | 예 |
| 66b75631-17a5-4af2-857f-98cca0e661e3 | PERDAY-ATOMIC-1793008370370 | 2026-10-26T09:52:56 | 0 | - | 전부 성공 | 예 |
| 7c63e12b-d77c-4f7b-85de-8286d8b9dae5 | PERDAY-ATOMIC-1793008370370 | 2026-10-26T09:52:56 | 0 | - | 전부 성공 | 예 |
| 7ca951ef-bd8f-49f2-85d4-bcb35b447561 | NEWCLASS-BUY-1793008506281 | 2026-10-26T09:55:13 | 0 | - | 전부 성공 | 예 |
| 800205db-d28d-4737-9eed-edab6a407fdd | NEWCLASS-GOODSCHK-1793006507779 | 2026-10-26T09:21:53 | 0 | - | 전부 성공 | 예 |
| 85800a8a-6b99-4670-bb25-bba645464100 | E2E 생애주기 대기승격 테스트 | 2026-10-26T09:25:16 | 2 | 탈퇴한 회원, CI User B | 전부 성공 | 예 |
| 94a54728-8db7-4e74-9901-54ba4a3fccff | NEWCLASS-SPECIFIC-1793008477860 | 2026-10-26T09:54:47 | 1 | CI User A | 전부 성공 | 예 |
| 95250034-8f0d-4538-b0a3-440635ac8677 | PERDAY-ATOMIC-1793006386909 | 2026-10-26T09:19:52 | 0 | - | 전부 성공 | 예 |
| 9994a6dd-1b2c-4456-b329-be398e50b743 | PERDAY-ATOMIC-1793008370370 | 2026-10-26T09:52:56 | 0 | - | 전부 성공 | 예 |
| 99dcd917-94f9-4755-a288-c2962d214bc2 | NEWCLASS-ALL-1793008450246 | 2026-10-26T09:54:21 | 1 | CI User A | 전부 성공 | 예 |
| a9fd581d-57cb-41da-ae67-41dfc84d32d8 | PERDAY-ATOMIC-1793006386909 | 2026-10-26T09:19:52 | 0 | - | 전부 성공 | 예 |
| adc1c555-1fbf-446a-bc55-080dec9cf732 | E2E 생애주기 예약 테스트 | 2026-10-26T09:25:17 | 2 | 탈퇴한 회원 | 전부 성공 | 예 |
| c74dbdc6-dbd4-4a3f-bc39-0e93d4591568 | NEWCLASS-ALL-1793006451909 | 2026-10-26T09:20:58 | 1 | CI User A | 전부 성공 | 예 |
| cfcb7946-a9d5-405e-a689-14ebdd05de80 | E2E 취소기한-성공 | 2026-10-26T09:27:21 | 1 | CI User A | 전부 성공 | 예 |
| dbad9f95-f19b-4130-8c10-13c68ba38d5c | PERDAY-ATOMIC-1793006386909 | 2026-10-26T09:19:52 | 0 | - | 전부 성공 | 예 |
| ec9a4dbe-8354-437b-bb71-e3c55c287d70 | PERDAY-ATOMIC-1793008370370 | 2026-10-26T09:52:56 | 0 | - | 전부 성공 | 예 |
| f8fcf95c-857a-41af-8bed-f4c39d22e8a6 | P3 출결-대기 | 2026-10-26T09:15:11 | 1 | CI User A | 전부 성공 | 예 |

## 항목별 소유권 근거·예상 삭제 범위

### 09089778-0438-4c9c-af6f-576e81d6c43e
- 센터 fb689293-c977-4684-9601-42e837f196fa · "E2E 취소기한-실패"
- 근거: CI 로그: run 40297920813(b571b24) 의 "E2E 4/4 " job 로그에 이 id 가 4회 등장(cleanup-blocked/mention), 생성 시각이 그 job 실행 구간(2026-10-26T09:24:19Z~2026-10-26T09:29:40Z) 안
- 근거: 제목 패턴이 tests/e2e/settings/cancel-deadline.spec.ts 의 고정 제목/생성 패턴과 일치
- 참조 건수: {"admin_action_logs.class_id":0,"class_trainers.class_id":0,"class_allowed_products.class_id":0,"reservations.class_id":0,"schedule_memos.class_id":0}
- 예상 삭제: {"reservations":0,"class":1,"cascadeChildren":[]}

### 156ca29c-bfaf-46a5-94a1-039bf2a685f6
- 센터 fb689293-c977-4684-9601-42e837f196fa · "NEWCLASS-SPECIFIC-1793006468708"
- 근거: CI 로그: run 40297920813(b571b24) 의 "E2E 3/4 " job 로그에 이 id 가 4회 등장(cleanup-blocked/mention), 생성 시각이 그 job 실행 구간(2026-10-26T09:19:59Z~2026-10-26T09:24:17Z) 안
- 근거: 제목의 Date.now() 값(1793006468708)과 생성 시각 차 5.7초 — 같은 spec 프로세스가 입력한 제목
- 근거: 제목 패턴이 tests/e2e/admin/new-class-creation.spec.ts 의 고정 제목/생성 패턴과 일치
- 참조 건수: {"admin_action_logs.class_id":0,"class_trainers.class_id":0,"class_allowed_products.class_id":1,"reservations.class_id":1,"schedule_memos.class_id":0,"admin_action_logs.reservation_id":0,"reservation_goods_usages.reservation_id":0}
- 예상 삭제: {"reservations":1,"class":1,"cascadeChildren":["class_allowed_products.class_id:1"]}

### 34a5d298-27e5-4ba9-9dcd-68e4c8bd0baa
- 센터 fb689293-c977-4684-9601-42e837f196fa · "E2E 대기인원표시 1793006627598"
- 근거: CI 로그: run 40297920813(b571b24) 의 "E2E 3/4 " job 로그에 이 id 가 4회 등장(cleanup-blocked/mention), 생성 시각이 그 job 실행 구간(2026-10-26T09:19:59Z~2026-10-26T09:24:17Z) 안
- 근거: 제목의 Date.now() 값(1793006627598)과 생성 시각 차 0.3초 — 같은 spec 프로세스가 입력한 제목
- 근거: 제목 패턴이 tests/e2e/reservation/group-waitlist-count-display.spec.ts 의 고정 제목/생성 패턴과 일치
- 참조 건수: {"admin_action_logs.class_id":0,"class_trainers.class_id":0,"class_allowed_products.class_id":0,"reservations.class_id":1,"schedule_memos.class_id":0,"admin_action_logs.reservation_id":0,"reservation_goods_usages.reservation_id":0}
- 예상 삭제: {"reservations":1,"class":1,"cascadeChildren":[]}

### 44920648-1629-4787-898e-fd9e34197653
- 센터 fb689293-c977-4684-9601-42e837f196fa · "PERDAY-ATOMIC-1793006386909"
- 근거: CI 로그: run 40297920813(b571b24) 의 "E2E 2/4 " job 로그에 이 id 가 4회 등장(cleanup-blocked/mention), 생성 시각이 그 job 실행 구간(2026-10-26T09:16:23Z~2026-10-26T09:19:58Z) 안
- 근거: 제목의 Date.now() 값(1793006386909)과 생성 시각 차 5.5초 — 같은 spec 프로세스가 입력한 제목
- 근거: 제목 패턴이 tests/e2e/admin/recurring-class-per-day-atomicity.spec.ts 의 고정 제목/생성 패턴과 일치
- 참조 건수: {"admin_action_logs.class_id":0,"class_trainers.class_id":0,"class_allowed_products.class_id":0,"reservations.class_id":0,"schedule_memos.class_id":0}
- 예상 삭제: {"reservations":0,"class":1,"cascadeChildren":[]}

### 547526ae-c808-42ee-9c62-43b4fd1ea20e
- 센터 fb689293-c977-4684-9601-42e837f196fa · "NEWCLASS-BUY-1793006483165"
- 근거: CI 로그: run 40297920813(b571b24) 의 "E2E 3/4 " job 로그에 이 id 가 4회 등장(cleanup-blocked/mention), 생성 시각이 그 job 실행 구간(2026-10-26T09:19:59Z~2026-10-26T09:24:17Z) 안
- 근거: 제목의 Date.now() 값(1793006483165)과 생성 시각 차 4.9초 — 같은 spec 프로세스가 입력한 제목
- 근거: 제목 패턴이 tests/e2e/admin/new-class-creation.spec.ts 의 고정 제목/생성 패턴과 일치
- 참조 건수: {"admin_action_logs.class_id":0,"class_trainers.class_id":0,"class_allowed_products.class_id":0,"reservations.class_id":0,"schedule_memos.class_id":0}
- 예상 삭제: {"reservations":0,"class":1,"cascadeChildren":[]}

### 650538db-f67d-4348-a3b3-a55520b9f7ab
- 센터 fb689293-c977-4684-9601-42e837f196fa · "E2E-210 요가 클래스"
- 근거: CI 로그: run 40297920813(b571b24) 의 "E2E 3/4 " job 로그에 이 id 가 16회 등장(cleanup-blocked/create-blocked-by-residue/mention), 생성 시각이 그 job 실행 구간(2026-10-26T09:19:59Z~2026-10-26T09:24:17Z) 안
- 근거: 제목 패턴이 tests/e2e/reservation/member-cancel/my-reservations-cancel-a11y.spec.ts 의 고정 제목/생성 패턴과 일치
- 참조 건수: {"admin_action_logs.class_id":0,"class_trainers.class_id":0,"class_allowed_products.class_id":0,"reservations.class_id":1,"schedule_memos.class_id":0,"admin_action_logs.reservation_id":0,"reservation_goods_usages.reservation_id":0}
- 예상 삭제: {"reservations":1,"class":1,"cascadeChildren":[]}

### 65baba3c-075f-4771-b41e-d07736f5a3fb
- 센터 fb689293-c977-4684-9601-42e837f196fa · "NEWCLASS-GOODSCHK-1793008541828"
- 근거: CI 로그: run 40300257985(7693998) 의 "E2E 3/4 " job 로그에 이 id 가 4회 등장(cleanup-blocked/mention), 생성 시각이 그 job 실행 구간(2026-10-26T09:53:02Z~2026-10-26T09:59:00Z) 안
- 근거: 제목의 Date.now() 값(1793008541828)과 생성 시각 차 8.8초 — 같은 spec 프로세스가 입력한 제목
- 근거: 제목 패턴이 tests/e2e/admin/new-class-creation.spec.ts 의 고정 제목/생성 패턴과 일치
- 참조 건수: {"admin_action_logs.class_id":0,"class_trainers.class_id":0,"class_allowed_products.class_id":0,"reservations.class_id":0,"schedule_memos.class_id":0}
- 예상 삭제: {"reservations":0,"class":1,"cascadeChildren":[]}

### 66b75631-17a5-4af2-857f-98cca0e661e3
- 센터 fb689293-c977-4684-9601-42e837f196fa · "PERDAY-ATOMIC-1793008370370"
- 근거: CI 로그: run 40300257985(7693998) 의 "E2E 2/4 " job 로그에 이 id 가 4회 등장(cleanup-blocked/mention), 생성 시각이 그 job 실행 구간(2026-10-26T09:49:30Z~2026-10-26T09:53:00Z) 안
- 근거: 제목의 Date.now() 값(1793008370370)과 생성 시각 차 5.7초 — 같은 spec 프로세스가 입력한 제목
- 근거: 제목 패턴이 tests/e2e/admin/recurring-class-per-day-atomicity.spec.ts 의 고정 제목/생성 패턴과 일치
- 참조 건수: {"admin_action_logs.class_id":0,"class_trainers.class_id":0,"class_allowed_products.class_id":0,"reservations.class_id":0,"schedule_memos.class_id":0}
- 예상 삭제: {"reservations":0,"class":1,"cascadeChildren":[]}

### 7c63e12b-d77c-4f7b-85de-8286d8b9dae5
- 센터 fb689293-c977-4684-9601-42e837f196fa · "PERDAY-ATOMIC-1793008370370"
- 근거: CI 로그: run 40300257985(7693998) 의 "E2E 2/4 " job 로그에 이 id 가 4회 등장(cleanup-blocked/mention), 생성 시각이 그 job 실행 구간(2026-10-26T09:49:30Z~2026-10-26T09:53:00Z) 안
- 근거: 제목의 Date.now() 값(1793008370370)과 생성 시각 차 5.7초 — 같은 spec 프로세스가 입력한 제목
- 근거: 제목 패턴이 tests/e2e/admin/recurring-class-per-day-atomicity.spec.ts 의 고정 제목/생성 패턴과 일치
- 참조 건수: {"admin_action_logs.class_id":0,"class_trainers.class_id":0,"class_allowed_products.class_id":0,"reservations.class_id":0,"schedule_memos.class_id":0}
- 예상 삭제: {"reservations":0,"class":1,"cascadeChildren":[]}

### 7ca951ef-bd8f-49f2-85d4-bcb35b447561
- 센터 fb689293-c977-4684-9601-42e837f196fa · "NEWCLASS-BUY-1793008506281"
- 근거: CI 로그: run 40300257985(7693998) 의 "E2E 3/4 " job 로그에 이 id 가 4회 등장(cleanup-blocked/mention), 생성 시각이 그 job 실행 구간(2026-10-26T09:53:02Z~2026-10-26T09:59:00Z) 안
- 근거: 제목의 Date.now() 값(1793008506281)과 생성 시각 차 7.0초 — 같은 spec 프로세스가 입력한 제목
- 근거: 제목 패턴이 tests/e2e/admin/new-class-creation.spec.ts 의 고정 제목/생성 패턴과 일치
- 참조 건수: {"admin_action_logs.class_id":0,"class_trainers.class_id":0,"class_allowed_products.class_id":0,"reservations.class_id":0,"schedule_memos.class_id":0}
- 예상 삭제: {"reservations":0,"class":1,"cascadeChildren":[]}

### 800205db-d28d-4737-9eed-edab6a407fdd
- 센터 fb689293-c977-4684-9601-42e837f196fa · "NEWCLASS-GOODSCHK-1793006507779"
- 근거: CI 로그: run 40297920813(b571b24) 의 "E2E 3/4 " job 로그에 이 id 가 4회 등장(cleanup-blocked/mention), 생성 시각이 그 job 실행 구간(2026-10-26T09:19:59Z~2026-10-26T09:24:17Z) 안
- 근거: 제목의 Date.now() 값(1793006507779)과 생성 시각 차 5.3초 — 같은 spec 프로세스가 입력한 제목
- 근거: 제목 패턴이 tests/e2e/admin/new-class-creation.spec.ts 의 고정 제목/생성 패턴과 일치
- 참조 건수: {"admin_action_logs.class_id":0,"class_trainers.class_id":0,"class_allowed_products.class_id":0,"reservations.class_id":0,"schedule_memos.class_id":0}
- 예상 삭제: {"reservations":0,"class":1,"cascadeChildren":[]}

### 85800a8a-6b99-4670-bb25-bba645464100
- 센터 fb689293-c977-4684-9601-42e837f196fa · "E2E 생애주기 대기승격 테스트"
- 근거: CI 로그: run 40297920813(b571b24) 의 "E2E 4/4 " job 로그에 이 id 가 4회 등장(cleanup-blocked/teardown-unresolved/mention), 생성 시각이 그 job 실행 구간(2026-10-26T09:24:19Z~2026-10-26T09:29:40Z) 안
- 근거: 제목 패턴이 tests/e2e/production-readiness/member-full-lifecycle.spec.ts 의 고정 제목/생성 패턴과 일치
- 참조 건수: {"admin_action_logs.class_id":0,"class_trainers.class_id":0,"class_allowed_products.class_id":0,"reservations.class_id":2,"schedule_memos.class_id":0,"admin_action_logs.reservation_id":0,"reservation_goods_usages.reservation_id":0}
- 예상 삭제: {"reservations":2,"class":1,"cascadeChildren":[]}

### 94a54728-8db7-4e74-9901-54ba4a3fccff
- 센터 fb689293-c977-4684-9601-42e837f196fa · "NEWCLASS-SPECIFIC-1793008477860"
- 근거: CI 로그: run 40300257985(7693998) 의 "E2E 3/4 " job 로그에 이 id 가 4회 등장(cleanup-blocked/mention), 생성 시각이 그 job 실행 구간(2026-10-26T09:53:02Z~2026-10-26T09:59:00Z) 안
- 근거: 제목의 Date.now() 값(1793008477860)과 생성 시각 차 9.2초 — 같은 spec 프로세스가 입력한 제목
- 근거: 제목 패턴이 tests/e2e/admin/new-class-creation.spec.ts 의 고정 제목/생성 패턴과 일치
- 참조 건수: {"admin_action_logs.class_id":0,"class_trainers.class_id":0,"class_allowed_products.class_id":1,"reservations.class_id":1,"schedule_memos.class_id":0,"admin_action_logs.reservation_id":0,"reservation_goods_usages.reservation_id":0}
- 예상 삭제: {"reservations":1,"class":1,"cascadeChildren":["class_allowed_products.class_id:1"]}

### 95250034-8f0d-4538-b0a3-440635ac8677
- 센터 fb689293-c977-4684-9601-42e837f196fa · "PERDAY-ATOMIC-1793006386909"
- 근거: CI 로그: run 40297920813(b571b24) 의 "E2E 2/4 " job 로그에 이 id 가 4회 등장(cleanup-blocked/teardown-unresolved/mention), 생성 시각이 그 job 실행 구간(2026-10-26T09:16:23Z~2026-10-26T09:19:58Z) 안
- 근거: 제목의 Date.now() 값(1793006386909)과 생성 시각 차 5.5초 — 같은 spec 프로세스가 입력한 제목
- 근거: 제목 패턴이 tests/e2e/admin/recurring-class-per-day-atomicity.spec.ts 의 고정 제목/생성 패턴과 일치
- 참조 건수: {"admin_action_logs.class_id":0,"class_trainers.class_id":0,"class_allowed_products.class_id":0,"reservations.class_id":0,"schedule_memos.class_id":0}
- 예상 삭제: {"reservations":0,"class":1,"cascadeChildren":[]}

### 9994a6dd-1b2c-4456-b329-be398e50b743
- 센터 fb689293-c977-4684-9601-42e837f196fa · "PERDAY-ATOMIC-1793008370370"
- 근거: CI 로그: run 40300257985(7693998) 의 "E2E 2/4 " job 로그에 이 id 가 4회 등장(cleanup-blocked/teardown-unresolved/mention), 생성 시각이 그 job 실행 구간(2026-10-26T09:49:30Z~2026-10-26T09:53:00Z) 안
- 근거: 제목의 Date.now() 값(1793008370370)과 생성 시각 차 5.7초 — 같은 spec 프로세스가 입력한 제목
- 근거: 제목 패턴이 tests/e2e/admin/recurring-class-per-day-atomicity.spec.ts 의 고정 제목/생성 패턴과 일치
- 참조 건수: {"admin_action_logs.class_id":0,"class_trainers.class_id":0,"class_allowed_products.class_id":0,"reservations.class_id":0,"schedule_memos.class_id":0}
- 예상 삭제: {"reservations":0,"class":1,"cascadeChildren":[]}

### 99dcd917-94f9-4755-a288-c2962d214bc2
- 센터 fb689293-c977-4684-9601-42e837f196fa · "NEWCLASS-ALL-1793008450246"
- 근거: CI 로그: run 40300257985(7693998) 의 "E2E 3/4 " job 로그에 이 id 가 4회 등장(cleanup-blocked/teardown-unresolved/mention), 생성 시각이 그 job 실행 구간(2026-10-26T09:53:02Z~2026-10-26T09:59:00Z) 안
- 근거: 제목의 Date.now() 값(1793008450246)과 생성 시각 차 10.8초 — 같은 spec 프로세스가 입력한 제목
- 근거: 제목 패턴이 tests/e2e/admin/new-class-creation.spec.ts 의 고정 제목/생성 패턴과 일치
- 참조 건수: {"admin_action_logs.class_id":0,"class_trainers.class_id":0,"class_allowed_products.class_id":0,"reservations.class_id":1,"schedule_memos.class_id":0,"admin_action_logs.reservation_id":0,"reservation_goods_usages.reservation_id":0}
- 예상 삭제: {"reservations":1,"class":1,"cascadeChildren":[]}

### a9fd581d-57cb-41da-ae67-41dfc84d32d8
- 센터 fb689293-c977-4684-9601-42e837f196fa · "PERDAY-ATOMIC-1793006386909"
- 근거: CI 로그: run 40297920813(b571b24) 의 "E2E 2/4 " job 로그에 이 id 가 4회 등장(cleanup-blocked/mention), 생성 시각이 그 job 실행 구간(2026-10-26T09:16:23Z~2026-10-26T09:19:58Z) 안
- 근거: 제목의 Date.now() 값(1793006386909)과 생성 시각 차 5.5초 — 같은 spec 프로세스가 입력한 제목
- 근거: 제목 패턴이 tests/e2e/admin/recurring-class-per-day-atomicity.spec.ts 의 고정 제목/생성 패턴과 일치
- 참조 건수: {"admin_action_logs.class_id":0,"class_trainers.class_id":0,"class_allowed_products.class_id":0,"reservations.class_id":0,"schedule_memos.class_id":0}
- 예상 삭제: {"reservations":0,"class":1,"cascadeChildren":[]}

### adc1c555-1fbf-446a-bc55-080dec9cf732
- 센터 fb689293-c977-4684-9601-42e837f196fa · "E2E 생애주기 예약 테스트"
- 근거: CI 로그: run 40297920813(b571b24) 의 "E2E 4/4 " job 로그에 이 id 가 4회 등장(cleanup-blocked/mention), 생성 시각이 그 job 실행 구간(2026-10-26T09:24:19Z~2026-10-26T09:29:40Z) 안
- 근거: 제목 패턴이 tests/e2e/production-readiness/member-full-lifecycle.spec.ts 의 고정 제목/생성 패턴과 일치
- 참조 건수: {"admin_action_logs.class_id":0,"class_trainers.class_id":0,"class_allowed_products.class_id":0,"reservations.class_id":2,"schedule_memos.class_id":0,"admin_action_logs.reservation_id":0,"reservation_goods_usages.reservation_id":0}
- 예상 삭제: {"reservations":2,"class":1,"cascadeChildren":[]}

### c74dbdc6-dbd4-4a3f-bc39-0e93d4591568
- 센터 fb689293-c977-4684-9601-42e837f196fa · "NEWCLASS-ALL-1793006451909"
- 근거: CI 로그: run 40297920813(b571b24) 의 "E2E 3/4 " job 로그에 이 id 가 4회 등장(cleanup-blocked/teardown-unresolved/mention), 생성 시각이 그 job 실행 구간(2026-10-26T09:19:59Z~2026-10-26T09:24:17Z) 안
- 근거: 제목의 Date.now() 값(1793006451909)과 생성 시각 차 6.1초 — 같은 spec 프로세스가 입력한 제목
- 근거: 제목 패턴이 tests/e2e/admin/new-class-creation.spec.ts 의 고정 제목/생성 패턴과 일치
- 참조 건수: {"admin_action_logs.class_id":0,"class_trainers.class_id":0,"class_allowed_products.class_id":0,"reservations.class_id":1,"schedule_memos.class_id":0,"admin_action_logs.reservation_id":0,"reservation_goods_usages.reservation_id":0}
- 예상 삭제: {"reservations":1,"class":1,"cascadeChildren":[]}

### cfcb7946-a9d5-405e-a689-14ebdd05de80
- 센터 fb689293-c977-4684-9601-42e837f196fa · "E2E 취소기한-성공"
- 근거: CI 로그: run 40297920813(b571b24) 의 "E2E 4/4 " job 로그에 이 id 가 4회 등장(cleanup-blocked/mention), 생성 시각이 그 job 실행 구간(2026-10-26T09:24:19Z~2026-10-26T09:29:40Z) 안
- 근거: 제목 패턴이 tests/e2e/settings/cancel-deadline.spec.ts 의 고정 제목/생성 패턴과 일치
- 참조 건수: {"admin_action_logs.class_id":0,"class_trainers.class_id":0,"class_allowed_products.class_id":0,"reservations.class_id":1,"schedule_memos.class_id":0,"admin_action_logs.reservation_id":0,"reservation_goods_usages.reservation_id":0}
- 예상 삭제: {"reservations":1,"class":1,"cascadeChildren":[]}

### dbad9f95-f19b-4130-8c10-13c68ba38d5c
- 센터 fb689293-c977-4684-9601-42e837f196fa · "PERDAY-ATOMIC-1793006386909"
- 근거: CI 로그: run 40297920813(b571b24) 의 "E2E 2/4 " job 로그에 이 id 가 4회 등장(cleanup-blocked/mention), 생성 시각이 그 job 실행 구간(2026-10-26T09:16:23Z~2026-10-26T09:19:58Z) 안
- 근거: 제목의 Date.now() 값(1793006386909)과 생성 시각 차 5.5초 — 같은 spec 프로세스가 입력한 제목
- 근거: 제목 패턴이 tests/e2e/admin/recurring-class-per-day-atomicity.spec.ts 의 고정 제목/생성 패턴과 일치
- 참조 건수: {"admin_action_logs.class_id":0,"class_trainers.class_id":0,"class_allowed_products.class_id":0,"reservations.class_id":0,"schedule_memos.class_id":0}
- 예상 삭제: {"reservations":0,"class":1,"cascadeChildren":[]}

### ec9a4dbe-8354-437b-bb71-e3c55c287d70
- 센터 fb689293-c977-4684-9601-42e837f196fa · "PERDAY-ATOMIC-1793008370370"
- 근거: CI 로그: run 40300257985(7693998) 의 "E2E 2/4 " job 로그에 이 id 가 4회 등장(cleanup-blocked/mention), 생성 시각이 그 job 실행 구간(2026-10-26T09:49:30Z~2026-10-26T09:53:00Z) 안
- 근거: 제목의 Date.now() 값(1793008370370)과 생성 시각 차 5.7초 — 같은 spec 프로세스가 입력한 제목
- 근거: 제목 패턴이 tests/e2e/admin/recurring-class-per-day-atomicity.spec.ts 의 고정 제목/생성 패턴과 일치
- 참조 건수: {"admin_action_logs.class_id":0,"class_trainers.class_id":0,"class_allowed_products.class_id":0,"reservations.class_id":0,"schedule_memos.class_id":0}
- 예상 삭제: {"reservations":0,"class":1,"cascadeChildren":[]}

### f8fcf95c-857a-41af-8bed-f4c39d22e8a6
- 센터 fb689293-c977-4684-9601-42e837f196fa · "P3 출결-대기"
- 근거: CI 로그: run 40297920813(b571b24) 의 "E2E 1/4 " job 로그에 이 id 가 4회 등장(cleanup-blocked/teardown-unresolved/mention), 생성 시각이 그 job 실행 구간(2026-10-26T09:13:56Z~2026-10-26T09:16:21Z) 안
- 근거: 제목 패턴이 tests/e2e/admin/attendance.spec.ts 의 고정 제목/생성 패턴과 일치
- 참조 건수: {"admin_action_logs.class_id":0,"class_trainers.class_id":0,"class_allowed_products.class_id":0,"reservations.class_id":1,"schedule_memos.class_id":0,"admin_action_logs.reservation_id":0,"reservation_goods_usages.reservation_id":0}
- 예상 삭제: {"reservations":1,"class":1,"cascadeChildren":[]}

## 근거의 한계(중요)
- Playwright trace/report 는 실패한 테스트에만 남는다(retain-on-failure). 통과한 테스트가 만든 수업(20건)의 생성 RPC 응답은 어떤 아티팩트에도 없어 '생성 응답 id' 근거를 제시할 수 없다.
- trace 에 id 가 나오는 3건(650538db, 85800a8a, f8fcf95c)은 '이전 실행 잔여와 충돌해 BLOCKED 된 오류 메시지'로만 나온다(생성 응답 아님).
- 이 잔여를 만든 두 CI 실행은 제목/manifest 에 실행 UUID 를 쓰기 전의 코드였고, manifest 는 러너와 함께 사라졌다. 따라서 실행 UUID 근거는 없다. 대신 (a) 같은 job 로그에 id 가 등장, (b) 생성 시각이 그 job 실행 구간 안, (c) 제목의 Date.now() 값(해당되는 경우)과 생성 시각 일치, (d) 예약은 테스트 프로필뿐·감사 로그 참조 0 으로 판단했다 — 이는 '증명'이 아니라 정황 증거이며 사람의 승인이 필요하다.

## trace 아티팩트 조회
- 09089778: trace/report 파일 0건
- 156ca29c: trace/report 파일 0건
- 34a5d298: trace/report 파일 0건
- 44920648: trace/report 파일 0건
- 547526ae: trace/report 파일 0건
- 650538db: trace/report 파일 10건
- 65baba3c: trace/report 파일 0건
- 66b75631: trace/report 파일 0건
- 7c63e12b: trace/report 파일 0건
- 7ca951ef: trace/report 파일 0건
- 800205db: trace/report 파일 0건
- 85800a8a: trace/report 파일 5건
- 94a54728: trace/report 파일 0건
- 95250034: trace/report 파일 0건
- 9994a6dd: trace/report 파일 0건
- 99dcd917: trace/report 파일 0건
- a9fd581d: trace/report 파일 0건
- adc1c555: trace/report 파일 0건
- c74dbdc6: trace/report 파일 0건
- cfcb7946: trace/report 파일 0건
- dbad9f95: trace/report 파일 0건
- ec9a4dbe: trace/report 파일 0건
- f8fcf95c: trace/report 파일 5건
