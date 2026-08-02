# 운영설정(`center_settings`) 전수 동작표 (2026-08-03 재검증)

`app/manager/settings/page.tsx`에 노출된 모든 설정을 UI 라벨 → DB 컬럼 → 저장 함수 → 조회
함수 → 실제 RPC/예약 로직 사용 여부 → 현재 동작 여부 → 테스트 존재 여부 → 이번 배치 처리로
정리한 표. "테스트가 통과한다"는 이유만으로 안심하지 않고, UI 저장 → RPC까지 실제 경로를
직접 추적해 작성했다.

| UI 라벨 | DB 컬럼 | 저장 함수 | 조회 함수 | 실제 사용처 | 현재 동작 | 테스트 | 이번 배치 처리 |
|---|---|---|---|---|---|---|---|
| 예약 마감(그룹) | `group_book_days_before/time` | `saveSettings` | `calc_deadline('book')` | `reserve_class()` | ✅ 정상 | 있음 | 변경 없음 |
| 예약 마감(프라이빗) | `private_book_days_before/time` | `saveSettings` | `calc_deadline('book')` | `reserve_class()` | ✅ 정상 | 신규 추가 | 테스트 보강 |
| 취소 마감(그룹/프라이빗) | `group/private_cancel_days_before/time` | `saveSettings` | `calc_deadline('cancel')` | `cancel_reservation()` | ✅ 정상 | 있음 | 변경 없음 |
| **예약 오픈 시점(그룹/프라이빗)** | `group/private_open_days_before/time` | `saveSettings` | ~~`calc_deadline('open')`~~ | `reserve_class()` | 🔴 **버그였음 → 수정 SQL 준비** | 신규 추가(그룹/프라이빗/KST경계) | **`fix_calc_deadline_open_kind_draft_proposed.sql`** |
| 당일 예약 허용 | `allow_same_day_booking` | `saveSettings` | 직접 조회 | `reserve_class()` | ✅ 정상(라이브 DB로 재검증 완료) | 신규 추가 | 테스트만 추가, 코드 변경 없음 |
| 당일 예약 변경 가능 시간 | `same_day_change_hours/minutes` | `saveSettings` | 없음 | 없음(스케줄러 필요) | 🟡 미작동 | 없음 | UI에 "준비 중" 배지 + 입력 비활성화 |
| 자동 폐강 | `autocancel_hours/minutes` | `saveSettings` | 없음 | 없음(스케줄러 필요) | 🟡 미작동 | 없음 | UI에 "준비 중" 배지 + 입력 비활성화 |
| 대기 자동 예약 시간 | `waitlist_auto_hours/minutes` | `saveSettings` | 없음 | 없음(스케줄러 필요 — 단, 취소 시점 즉시 승격은 별도로 정상 동작 중) | 🟡 미작동(값 자체는) | 없음 | UI에 "준비 중" 배지 + 입력 비활성화, 즉시승격은 정상이라는 안내 문구 추가 |
| 대기예약 주간 제한 | `waitlist_weekly_limit` | `saveSettings` | 직접 조회 | `reserve_class()` | ✅ 정상 | 있음 | 변경 없음 |
| 일일 예약 제한 | `daily_book_limit_enabled/limit` | `saveSettings` | 직접 조회 | `reserve_class()` | ✅ 정상 | 있음 | 변경 없음 |
| 회원 예약 인원 표시 | `show_group_reserved_count` | `saveSettings` | 없음(신규 연결) | 없음 → `app/reservation/page.tsx` | 🔴 미작동 → ✅ 구현 | 없음(수동 QA로 확인 필요) | **`lib/reservations.ts`/`app/reservation/page.tsx` 연결** |
| 회원 대기 인원 표시 | `show_group_waitlist_count` | `saveSettings` | 없음 | 없음(표시할 대기인원 수 자체가 어디에도 없음) | 🟡 미작동 | 없음 | 이번엔 미구현(표시 대상 신설 필요, `docs/TODO.md` 후속 P1 후보) |
| 프라이빗 슬롯 단위 | `private_slot_unit` | `saveSettings` | 없음 | 없음(슬롯 예약 시스템 자체가 없음) | 🟡 미작동 | 없음 | 구현 안 함 — `08_Decision_Log.md` DEC-002 |
| 프라이빗 동시예약 제한 | `private_max_concurrent_enabled/count` | `saveSettings` | 없음 | 없음 | 🟡 미작동 | 없음 | 구현 안 함 — DEC-002 |
| 늦은 취소 차감 | `deduct_on_late_cancel` | `saveSettings` | 직접 조회 | `cancel_reservation()` | ✅ 정상 | 있음 | 변경 없음 |
| 미수금 자동입력 | `auto_unpaid_input` | `saveSettings` | 없음(신규 연결) | 없음 → `app/manager/sales/page.tsx` | 🔴 미작동 → ✅ 구현 | 신규 추가(`computeAutoUnpaid` 단위테스트) | **`lib/sales.ts`/`app/manager/sales/page.tsx` 연결** |
| 포인트 내역 표시 | `show_point_history` | `saveSettings` | 없음 | 없음(포인트 내역 페이지 자체가 없음) | 🟡 미작동 | 없음 | 구현 안 함 — 페이지 신설이 필요한 별도 기능(`docs/TODO.md`) |
| 문의게시판/락커/라운지 사용 | `use_inquiry_board/locker/lounge` | `saveSettings` | 없음 | 없음 | ✅ 처리됨(이전 배치 E-6에서 UI 제거) | - | 변경 없음 |

## 범례

- ✅ 정상: UI 저장값이 실제 RPC/화면 동작에 그대로 반영됨(재검증 완료)
- 🔴 미작동 → 구현/수정: 이번 배치에서 실제로 고침
- 🟡 미작동(이번엔 유지): 스케줄러·별도 UI 등 더 큰 작업이 필요해 이번엔 "준비 중" 표시 또는
  미구현으로 남기고 문서화만 함(제품 결정 필요 항목은 Decision Log로 분리)

## 핵심 발견 3가지

1. **`calc_deadline()`의 `'open'` kind 미처리** — 가장 심각. `reserve_class()`는 올바르게
   호출하지만 함수 자체가 그 kind를 몰라 취소 마감 설정값을 대신 썼다. 수정 SQL 준비 완료,
   승인 대기.
2. **`show_group_reserved_count`/`auto_unpaid_input`은 UI에 실제 대상이 이미 있어서 작은
   범위로 구현 가능했다** — 이번 배치에서 완료.
3. **나머지 미작동 항목은 전부 "스케줄러 인프라 없음" 또는 "표시/관리 UI 자체가 없음"이
   근본 원인** — 토글 하나로 해결되는 게 아니라 별도 기능 개발이 필요해, 정상 기능처럼
   보이지 않도록 "준비 중" 표시 또는 미구현 상태를 명확히 문서화하는 것으로 이번 배치를
   마무리했다.
