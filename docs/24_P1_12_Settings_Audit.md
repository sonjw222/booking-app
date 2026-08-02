# 24. P1-12 운영설정(`center_settings`) 전수 사용처 감사

| 항목 | 값 |
|---|---|
| 문서 목적 | `/manager/settings`에서 저장되는 `center_settings`의 모든 필드가 실제 예약 로직 어디에서 읽히는지 전수 확인 |
| 조사일 | 2026-08-02 |
| 근거 파일 | `schema.sql`(`center_settings` 정의), `lib/settings.ts`, `app/manager/settings/page.tsx`, `reservation_functions.sql`, `add_class_products.sql`, `add_membership_rules.sql` |
| 관련 | [TODO.md P1-12](./TODO.md), `fix_settings_wire_reservation_logic_draft_proposed.sql`(이번 배치 SQL 초안) |

## 1. 조사 방법

`center_settings`의 각 컬럼명을 저장소 전체(`*.sql`, `lib/`, `app/`)에서 grep해 실제로 그 값을
읽는 SQL 함수 또는 TS 코드가 있는지 확인했다. `lib/settings.ts`(저장/조회 매핑 자체)와
`app/manager/settings/page.tsx`(화면 입력 폼)는 "사용처"로 세지 않는다 — 저장만 되고 어디서도
읽지 않으면 Dead Code로 분류한다.

## 2. 전체 34개 필드 사용처 표

| 필드 | 저장 위치 | 읽는 위치(이번 배치 전) | 예약 로직에 실제 반영? | Dead Code? | 필요한 수정 |
|---|---|---|---|---|---|
| `private_book_days_before/time` | `lib/settings.ts` → `center_settings` | `calc_deadline()`(`'book'`,`'private'`) | O (기존) | X | 없음 |
| `group_book_days_before/time` | 〃 | `calc_deadline()`(`'book'`,`'group'`) | O (기존) | X | 없음 |
| `private_cancel_days_before/time` | 〃 | `calc_deadline()`(`'cancel'`,`'private'`) | O (기존) | X | 없음 |
| `group_cancel_days_before/time` | 〃 | `calc_deadline()`(`'cancel'`,`'group'`) | O (기존) | X | 없음 |
| `deduct_on_late_cancel` | 〃 | `cancel_reservation()` | O (기존) | X | 없음 |
| `allow_same_day_booking` | 〃 | (없음) | X | O | **SQL** — 이번 배치에서 `reserve_class()`에 추가 |
| `daily_book_limit_enabled` / `daily_book_limit` | 〃 | (없음) | X | O | **SQL** — 이번 배치에서 `reserve_class()`에 추가 |
| `waitlist_weekly_limit` | 〃 | (없음) | X | O | **SQL** — 이번 배치에서 `reserve_class()`에 추가 |
| `private_open_days_before/time` | 〃 | (없음) | X | O | **SQL** — 이번 배치에서 `calc_deadline('open')`+`reserve_class()`에 추가 |
| `group_open_days_before/time` | 〃 | (없음) | X | O | **SQL** — 이번 배치에서 `calc_deadline('open')`+`reserve_class()`에 추가 |
| `same_day_change_hours/minutes` | 〃 | (없음) | X | O | 보류 — `allow_same_day_booking`(불리언)과 의미가 겹침("허용 여부" vs "N시간 M분 전까지 변경"). 어느 쪽이 최종 정책인지 제품 결정 필요. 결정 후 SQL |
| `autocancel_hours/minutes` | 〃 | (없음) | X | O | 보류 — 최소인원 미달 자동폐강은 주기 실행(cron/scheduler) 필요, `reserve_class()` 같은 동기 흐름에 넣을 수 없음. 스케줄러 인프라(P0-5와 동일 종류) 먼저 필요 |
| `waitlist_auto_hours/minutes` | 〃 | (없음) | X | O | 보류 — 공석 발생 시 자동 승격은 이미 `cancel_reservation()`이 즉시 처리 중(대기 1번 즉시 승격). "시작 N시간 전까지만" 조건부 자동승격은 별도 스케줄러 필요 — autocancel과 동일한 인프라 의존성 |
| `private_slot_unit` | 〃 | (없음) | X | O | 보류 — 프라이빗 수업 예약 시 시간 슬롯을 고르는 UI 자체가 없음(현재 프라이빗/그룹 모두 관리자가 만든 고정 `start_time`에 예약). 슬롯 선택 UI 신설은 이번 범위 밖 |
| `private_max_concurrent_enabled/_count` | 〃 | (없음) | X | O | 보류 — "같은 시간대 동시 생성 가능한 프라이빗 수업 수" 제한은 수업 **생성** 시점(`add_class` 계열) 검증이 필요해 `reserve_class()`(예약 시점) 범위 밖. 별도 트리거/RPC 설계 필요 |
| `show_group_reserved_count` | 〃 | (없음) | X | O | 보류 — TS만 수정하면 되는 항목(`app/reservation/page.tsx`의 `예약 {reserved}/{capacity}` 표시를 이 값으로 gating). 다만 그 값을 담는 `centers`(`CenterInfo`, `lib/reservations.ts`의 `fetchMonthData()`)가 현재 설정을 안 실어 나름 — 핵심 캘린더 조회 함수를 건드려야 해서 이번 배치(reserve_class 확장) 범위와 성격이 다름. 별도 배치 권장 |
| `show_group_waitlist_count` | 〃 | (없음) | X | O | 위와 동일 사유로 보류 |
| `use_inquiry_board` | 〃 | (없음) | X | O | 보류 — 문의 게시판을 센터별로 끄는 기능 자체가 화면에 없음(항상 노출). 게이팅 UI 신설 필요 |
| `show_all_classes` | 〃 | (없음) | X | O | 보류 — "수강권으로 볼 수 없는 수업도 표시"를 반영할 필터링 로직이 회원 예약 화면에 없음(현재는 항상 전체 표시). 신규 로직 필요 |
| `use_locker` | 〃 | (없음) | X | O | 보류 — 락커 기능 자체가 미구현(P3-2와 동일 사안) |
| `auto_unpaid_input` | 〃 | (없음) | X | O | 보류 — "수강권 미수금 자동 입력"을 수행할 결제/미수금 로직이 없음(P0-1 실제 PG 연동 이후에나 의미 있음) |
| `use_lounge` | 〃 | (없음) | X | O | 보류 — 라운지 기능 자체가 미구현 |
| `show_point_history` | 〃 | (없음) | X | O | 보류 — 회원앱 포인트 내역 화면이 이미 이 설정과 무관하게 항상 노출됨(P1-1 포인트 원장 이원화와 얽힌 별도 사안) |

## 3. 요약

- 총 34개 필드(비식별용 `center_id`, `updated_at` 제외).
- **이번 배치 전 실사용**: 9개(예약/취소 마감시각 8개 + `deduct_on_late_cancel`).
- **이번 배치에서 새로 배선(SQL)**: 8개(`allow_same_day_booking`, `daily_book_limit_enabled`,
  `daily_book_limit`, `waitlist_weekly_limit`, `private_open_days_before`, `private_open_time`,
  `group_open_days_before`, `group_open_time`) — `fix_settings_wire_reservation_logic_draft_proposed.sql`.
- **여전히 Dead Code로 남는 17개**: 위 표에서 "보류"로 표시한 항목. 사유는 크게 3가지로 나뉜다.
  1. **스케줄러 인프라 부재**(`autocancel_*`, `waitlist_auto_*`) — P0-5(정기 알림 스케줄러)와 같은
     종류의 선행 작업이 필요. `reserve_class()`처럼 요청 시점에 동기로 실행되는 함수에는 넣을 수 없음.
  2. **대응 UI/로직 자체가 없음**(`private_slot_unit`, `private_max_concurrent_*`,
     `show_group_reserved_count`, `show_group_waitlist_count`, `use_inquiry_board`,
     `show_all_classes`, `use_locker`, `auto_unpaid_input`, `use_lounge`, `show_point_history`) —
     설정을 반영할 화면 기능 자체를 새로 만들어야 해서 "설정 배선" 범위를 넘는 별도 기능 개발.
  3. **정책 자체가 모호함**(`same_day_change_hours/minutes`) — `allow_same_day_booking`(불리언)과
     역할이 겹쳐 제품 결정 없이는 어느 쪽이 맞는 최종 동작인지 판단할 수 없음.
- 이 17개는 화면에서 "준비 중" 표시로 명시할지, 하나씩 개별 P2/P3 TODO로 승격해 순차 구현할지는
  제품 결정이 필요하다 — 이번 배치에서는 판단하지 않고 이 표로 근거만 남긴다.
