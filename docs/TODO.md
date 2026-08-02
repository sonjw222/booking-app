# TODO

## 1. 문서 메타데이터

| 항목 | 값 |
|---|---|
| 문서 목적 | 확인된 미완성·확인 필요·운영 설정 필요 항목의 실행 목록 |
| 최종 검증일 | 2026-07-28 |
| 기준 문서 | [REQUIREMENTS.md](./REQUIREMENTS.md) · [DATABASE.md](./DATABASE.md) |
| 상태 원칙 | 코드·운영 환경·사용자 결정의 완료 증거가 확인되기 전에는 완료 처리하지 않음 |

## 2. 우선순위와 상태 기준

### 우선순위

| 우선순위 | 기준 |
|---|---|
| **P0** | 결제·예약·알림 핵심 흐름, 권한 보안, 운영 DB 재현성과 직접 관련 |
| **P1** | 사용자에게 노출된 미완성 기능 또는 돈·개인정보의 정합성 위험 |
| **P2** | 운영 설정, 협업 오류, 유지보수 위험 또는 제품 결정이 필요한 기능 |
| **P3** | 현재 화면과 연결되지 않은 향후 기능 후보 또는 존속 여부 확인 |

### 현재 상태

| 상태 | 의미 |
|---|---|
| **미완성** | 코드나 UI 일부만 존재하고 제품 흐름이 끝까지 동작하지 않음 |
| **확인 필요** | 저장소에서 근거 일부는 확인했으나 운영 상태·관계·제품 결정을 확정할 수 없음 |
| **운영 설정 필요** | 앱·SQL은 존재하지만 Supabase·OAuth·Realtime·Storage 등 외부 설정이 필요 |

### 완료 처리 규칙

1. 아래 “완료 조건”을 실제로 검증한 경우에만 완료 처리합니다.
2. 파일을 추가한 것과 운영 환경에 적용한 것을 구분합니다.
3. UI가 생긴 것과 데이터·권한 흐름이 연결된 것을 구분합니다.
4. 운영 DB 상태는 SQL 파일 존재만으로 완료 처리하지 않습니다.
5. 사용자 결정이 필요한 기능은 결정 기록 없이 완료 처리하지 않습니다.
6. 완료된 항목은 [CHANGELOG.md](./CHANGELOG.md)에 근거와 함께 기록한 뒤 이 문서에서 제거하거나 완료 이력으로 이동합니다.

## 3. P0 — 핵심 거래·알림·보안·DB 재현성

### P0-1. 실제 PG 결제 연동

| 필드 | 내용 |
|---|---|
| 우선순위 | P0 |
| 현재 상태 | **미완성 (테스트 결제 환경만 완료)** |
| 근거 파일 | `app/checkout/page.tsx`, `lib/orders.ts`, `lib/payments/*`(신규), `add_payment_test_provider.sql`(신규), `add_orders.sql`, `schema.sql` |
| 완료 조건 | Toss/PortOne 실제 운영 키로 결제 생성·성공·실패·취소·중복 callback을 검증하고, 성공 주문만 발급되며 `orders`·`payments` 상태가 일치함. 사업자 등록 후 진행 가능 |
| 관련 문서 | [REQUIREMENTS 6-1, 10-4](./REQUIREMENTS.md), [DATABASE 4-3, 7-3](./DATABASE.md), [ROUTES `/checkout`](./ROUTES.md) |

**2026-07-30 진행 상황**: 사업자 미등록으로 Toss/PortOne 운영 키를 아직 쓸 수 없어, **Payment Adapter Pattern으로 테스트 결제 환경만 우선 구축**했습니다.
- `Checkout → PaymentService → PaymentProviderFactory → PaymentProvider(interface) → {Mock|Toss|PortOne}` 구조. `NEXT_PUBLIC_PAYMENT_PROVIDER` 값만 바꾸면(mock→toss/portone) Checkout/Reservation/Order 코드 수정 없이 전환 가능하도록 설계.
- `MockPaymentProvider`만 실제 동작(success/failed/cancelled 3개 시나리오, `NEXT_PUBLIC_PAYMENT_SCENARIO` 또는 checkout의 `?mockScenario=` 쿼리로 선택). `TossPaymentProvider`/`PortOnePaymentProvider`는 인터페이스 구현 구조만 준비(메서드 본문은 미구현 — 사업자 등록 후 채울 것).
- 회원 본인이 테스트 결제를 즉시 확정할 수 있도록 `confirm_test_payment`/`cancel_test_payment` RPC 2개 신설(`add_payment_test_provider.sql`). **`fulfill_order`는 전혀 수정하지 않음.**

**⚠ 알려진 중복 (의도적, 향후 리팩터링 필요)**: `confirm_test_payment()`와 기존 `fulfill_order()`(`add_order_fulfillment.sql`)는 "수강권 발급 + 매출 기록 + 주문 완료 처리" 로직이 거의 동일합니다.
- **왜 중복이 발생했는가**: `fulfill_order`는 매니저/운영자 전용 권한 모델(security definer + `my_managed_center_ids()`)이고, `confirm_test_payment`는 회원 본인 소유 + `payment_provider='mock'` 한정이라는 **서로 다른 신뢰 모델**을 전제로 합니다. 공통 함수로 뽑으려면 `fulfill_order`의 시그니처/본문을 손대야 하는데, 이번 작업 규칙상 기존 RPC 변경이 금지되어 있어 중복을 허용했습니다.
- **어떻게 공통화할 수 있는가**: 권한 체크가 없는 순수 로직(멤버십 insert + 매출 insert + 주문 상태 갱신)만 내부 헬퍼 함수(예: `_issue_membership_and_record_payment`, 권한 검증 없음)로 뽑아내고, `fulfill_order`/`confirm_test_payment`(또는 향후 `confirm_real_payment`)가 각자 권한 체크를 마친 뒤 이 헬퍼를 호출하는 구조로 정리할 수 있습니다.
- **향후 리팩터링 계획**: 실제 PG(Toss/PortOne) 연동 + 웹훅 핸들러를 붙이는 시점(P0-1 후속 작업)에 위 공통화를 함께 진행합니다. 지금 당장 손대지 않습니다.

이전 문구(참고용): 과거 “결제하기”는 `orders.status = pending` 주문만 만들고 매니저가 수동 발급했습니다. 지금은 Mock 결제 성공 시 즉시 자동 발급되지만, 이는 **테스트 결제**이며 실제 결제가 아닙니다 — 실제 PG 연동 전까지는 이 사실이 화면 문구에 명확히 표시돼야 합니다(현재 checkout 화면에 "(Mock)" 표기로 반영함).

### P0-2. 운영 DB migration ledger와 최종 객체 검증

| 필드 | 내용 |
|---|---|
| 우선순위 | P0 |
| 현재 상태 | **확인 필요** |
| 근거 파일 | 루트 SQL 67개, `schema.sql`, `reservation_functions.sql`, `README.md`, `docs/DATABASE.md` |
| 완료 조건 | 운영 DB에 적용된 migration 파일·순서·적용일을 기록하고, 새 환경에서 같은 순서로 재현됨. 누락·중복 적용 여부를 확인함 |
| 관련 문서 | [DATABASE 12절](./DATABASE.md), [DEVELOPMENT_RULES 6절](./DEVELOPMENT_RULES.md) |

README의 큰 순서만으로 전체 migration을 재현할 수 있는지 검증되지 않았습니다. SQL 파일 목록을 실행 순서로 간주하면 안 됩니다.

### P0-3. 핵심 RPC의 운영 최종 본문 확인

| 필드 | 내용 |
|---|---|
| 우선순위 | P0 |
| 현재 상태 | **확인 필요** |
| 근거 파일 | `reservation_functions.sql`, `wire_settings.sql`, `add_*.sql`, `fix_*.sql`, 특히 `fix_usable_memberships_shared.sql` |
| 완료 조건 | 운영 DB에서 `pg_get_functiondef()`로 핵심 RPC 본문을 추출해 저장소의 의도한 최종본과 대조하고 역할별 회귀 테스트를 통과함 |
| 관련 문서 | [DATABASE 9절, 12-5](./DATABASE.md), [REQUIREMENTS 10절](./REQUIREMENTS.md) |

확인 대상:

- `reserve_class`
- `cancel_reservation`
- `fulfill_order`
- `manager_set_attendance`
- `usable_memberships`
- `usable_memberships_for_classes`
- `reserve_with_membership`
- `auto_book_membership`
- `has_permission`
- `is_platform_admin`

특히 `fix_usable_memberships_shared.sql`의 운영 적용 여부는 저장소만으로 알 수 없습니다. 적용 확인 전에는 “미적용”이나 “적용 완료”로 단정하지 않습니다.

### P0-4. RLS 회귀 테스트와 운영 정책 확인

| 필드 | 내용 |
|---|---|
| 우선순위 | P0 |
| 현재 상태 | **확인 필요** |
| 근거 파일 | `fix_profile_rls_restore.sql`, `fix_missing_primary_profile.sql`, `fix_rls_policies.sql`, `fix_membership_rls.sql`, `fix_staff_search.sql`, `add_roster_rls.sql`, `fix_member_status.sql`, `fix_center_reviews.sql` |
| 완료 조건 | 비로그인·회원·스태프·매니저·오너·플랫폼 운영자별 핵심 테이블 read/write 테스트를 자동화하거나 반복 가능한 체크리스트로 실행하고 현재 `pg_policies` 결과를 기록함 |
| 관련 문서 | [DATABASE 7절, 10절](./DATABASE.md), [REQUIREMENTS 4절](./REQUIREMENTS.md), [ROUTES 2절](./ROUTES.md) |

API 서버 없이 RLS/RPC가 최종 보안 경계이며 과거 긴급 보정 SQL이 반복되어 재발 위험이 큽니다.

**2026-08-01 ACL-003 서버 측 재검증에서 실제 FAIL 발견, 2026-08-02 수정 SQL 실행 완료**:
`account_center_permissions`의 SELECT 정책이 "같은 센터 소속 스태프면 누구나"로 열려 있어,
`facility.role_permission` 권한이 없는 일반 스태프가 Supabase SDK 직접 호출로 다른 스태프의
개인 권한 예외를 읽을 수 있었음(쓰기는 안전, 읽기만 취약). 수정 SQL
`fix_account_center_permissions_select_draft_proposed.sql`을 사용자가 Supabase SQL Editor에서
직접 실행(Success 확인), 이후 `tests/integration/acl-003-permission-read.test.ts` 3/3 통과,
전체 통합 테스트·PR #19 CI green 확인까지 마치고 `feature/access-control-guards`(PR #19)에
포함되어 main에 병합됨(ACL-001~005 Batch). **이 개별 결함은 해결되었습니다** — 다만 P0-4
자체(전체 RLS 회귀 테스트를 반복 가능한 체크리스트/자동화로 확립하는 것)의 완료 조건은 아직
충족되지 않아 P0-4 전체는 계속 "확인 필요" 상태로 둡니다(이번엔 `account_center_permissions`
한 테이블만 개별 대응했고, 전 테이블 반복 가능 체크리스트는 별도).

### P0-5. 정기 알림 스케줄러

| 필드 | 내용 |
|---|---|
| 우선순위 | P0 |
| 현재 상태 | **운영 설정 필요** |
| 근거 파일 | `add_notifications.sql`, `README.md`; 함수 `notify_upcoming_reservations()`, `notify_expiring_passes()` |
| 완료 조건 | 운영 Supabase의 pg_cron 또는 승인된 scheduler가 정해진 주기로 두 함수를 실행하고, 중복 없이 알림이 생성되는 것을 운영 또는 staging에서 확인함 |
| 관련 문서 | [REQUIREMENTS 6-2](./REQUIREMENTS.md), [DATABASE 9-3, 12-5](./DATABASE.md) |

함수 존재만으로 자동 알림이 실행되는 것은 아닙니다.

### P0-6. 휴무일 강제 지정 시 취소된 예약의 수강권 횟수가 복구되지 않음

| 필드 | 내용 |
|---|---|
| 우선순위 | P0 |
| 현재 상태 | **해결됨 — 2026-08-02 SQL 2건(수강권 복구 + admin_action_logs FK 2개 컬럼) 실행 완료, CI 통합 테스트 green 확인** |
| 근거 파일 | `reservation_functions.sql`(`add_holiday_safe` 함수), `app/manager/holidays/page.tsx`, `fix_holiday_membership_restore_draft_proposed.sql`(실행됨), `fix_admin_action_logs_class_id_fk_draft_proposed.sql`(실행됨), `tests/integration/holiday-membership-restore.test.ts` |
| 완료 조건 | `add_holiday_safe`가 확정/대기/출석 예약을 강제 취소할 때 `admin_cancel_reservation`/`manager_set_attendance`와 동일하게 `memberships.remaining_count`를 복구하도록 RPC를 수정하고, 예약자 있는 날짜를 휴무일로 지정하는 통합 테스트로 회귀 확인함 |
| 관련 문서 | [23_Admin_Feature_Audit.md](./23_Admin_Feature_Audit.md) 8번 항목 |

**2026-08-02 SQL 실행 후 재검증에서 sibling 버그 추가 발견**: `fix_holiday_membership_restore_draft_proposed.sql` 실행으로
`admin_action_logs.reservation_id` FK 문제는 해결됐으나, 재실행한 회귀 테스트에서 **다른 컬럼의 동일한
문제**가 드러났다 — `admin_action_logs.class_id`도 `not null references classes(id)`인데 ON DELETE
지정이 없어(기본 RESTRICT), `add_holiday_safe`의 `delete from classes` 단계에서 여전히 FK 위반이
발생한다(`admin_action_logs_class_id_fkey`). `add_admin_assignment.sql`의 `admin_action_logs` 정의를
전수 재확인해 이 두 컬럼(`reservation_id`, `class_id`) 외에 `add_holiday_safe`가 삭제하는 테이블을
참조하는 not null FK는 더 없음을 확인함(`center_id`/`admin_id`/`member_profile_id`는 삭제 안 되는
테이블 참조, `membership_id`/`source_unassigned_id`는 이미 nullable이고 memberships는 삭제 안 됨).
`class_id`도 동일하게 nullable + `ON DELETE SET NULL`로 바꾸는 `fix_admin_action_logs_class_id_fk_draft_proposed.sql`(+rollback)을
준비했다. `lib/adminAssignment.ts`의 `AdminActionLog.classId`도 `string | null`로 맞춰 반영함
(런타임 영향 없음, build 확인).

**2026-08-02 SQL 실행 완료 및 최종 검증**: 사용자가 이 SQL을 Supabase에서 실행 완료. 재검증 중
회귀 테스트 자체의 마지막 버그(테스트 기대값 오류 — `admin_assign_reservation()` 호출 자체가
`remaining_count`를 실제로 소모시키는 것을 fixture 재작성 시 반영하지 않아 "3→4"가 아니라
정확히는 "3→2(소모)→3(복구)"여야 했음)를 발견해 수정. 이후 CI에서
**`tests/integration/holiday-membership-restore.test.ts` 전체 green, 전체 통합 테스트
7 test files / 49 tests 전부 통과**를 확인했습니다. **이 항목은 완전히 해결되었습니다.**

2026-08-02 Track B 관리자 기능 감사에서 발견: 매니저가 예약자가 있는 날짜를 휴무일로 지정하면
`add_holiday_safe`가 해당 예약들을 강제로 지우면서(`delete from reservations`) 그 예약에 쓰인
수강권의 `remaining_count`를 전혀 복구하지 않습니다. 같은 "취소" 성격의 다른 경로
(`admin_cancel_reservation`, `manager_set_attendance`의 취소 처리)는 전부 정확히 +1 복구하는
것과 대조적입니다 — 회원이 수강권 횟수를 영구히 잃는 실질적 금전/재화 손실 버그입니다.
부수 발견: 같은 함수가 권한 체크에 `schedule.own.group.delete`(원래 "수업그룹 삭제" 용도)
권한 키를 재사용하고 있어, 세분권한 도입 시 의미가 부정확할 수 있습니다(이번 수정에서 함께
바꾸지 않음 — 별도 판단 필요).

**2026-08-02 후속 배치에서 수정 SQL 작성 완료**: `add_holiday_safe`가 삭제 직전 `status in
('confirmed','attended') and membership_consumed and membership_id is not null`인 예약을
`membership_id`별로 집계해 `remaining_count`를 복구하도록 수정(`remaining_count is not null`
가드로 무제한권은 건드리지 않음). DELETE 기반 구조는 그대로 유지(FK에 `ON DELETE CASCADE`가
없어 UPDATE-cancelled 방식으로 바꾸면 `delete from classes`가 FK 위반으로 실패함 — 기존
`delete_class_safe`도 동일하게 예약을 먼저 지우는 패턴이라 이 아키텍처를 새로 만들지 않음).
`fix_holiday_membership_restore_draft_proposed.sql`(+ 짝을 이루는 rollback 파일)로 준비했고
**아직 Supabase에 실행하지 않았습니다** — 사용자 승인 후 실행 필요. 회귀 테스트
`tests/integration/holiday-membership-restore.test.ts`는 SQL 적용 전에는 의도적으로 FAIL하고,
적용 후 green이 되어야 정상입니다.

**2026-08-02 회귀 테스트 작성 중 별도 버그를 추가로 발견해 같은 SQL 파일에 함께 수정**:
`admin_action_logs.reservation_id`가 `not null references reservations(id)`인데 ON DELETE
지정이 없어(기본 RESTRICT), 관리자 직접배치/무료배치로 만들어진 예약이 하루에 하나라도
있으면 `add_holiday_safe`의 `delete from reservations`가 FK 위반으로 **통째로 실패**하고
있었습니다(휴무일도 등록 안 되고 매니저에게는 원인불명의 SQL 에러만 노출 — 실제 운영에서
"관리자 직접배치"를 한 번이라도 쓴 센터라면 재현 가능한 실질적 P0급 버그). `reservation_id`를
nullable로 바꾸고 `ON DELETE SET NULL`로 교체해 감사 로그 행(스냅샷 컬럼으로 이미 의미 유지
가능하도록 설계돼 있었음)은 보존하면서 참조만 끊도록 함께 수정했습니다(`AdminActionLog.reservationId`
타입도 `lib/adminAssignment.ts`에서 `string | null`로 맞춤 — 현재 이 필드를 읽는 화면 코드가
없어 런타임 영향 없음, `npm run build` 확인). `delete_class_safe`/`delete_class_group_safe`도
취소·노쇼 예약을 삭제할 때 같은 FK 위반을 겪을 수 있는 잠재적 사안이지만, 이번 FK 완화로
함께 해결되며 그 두 함수 자체는 이번 배치에서 손대지 않았습니다.

## 4. P1 — 사용자 노출 미완성·금전·권한 UX

### P1-1. 포인트 원장 이원화 정합성

| 필드 | 내용 |
|---|---|
| 우선순위 | P1 |
| 현재 상태 | **확인 필요** |
| 근거 파일 | `lib/sales.ts`, `lib/reviews.ts`, `add_sales.sql`, `add_reviews_points.sql`; `point_transactions`, `point_accounts`, `point_logs` |
| 완료 조건 | 적립·사용·후기 보상·결제 사용의 기준 원장을 제품 정책으로 확정하고, 두 체계의 동기화 또는 migration을 구현해 모든 화면에서 같은 잔액을 검증함 |
| 관련 문서 | [REQUIREMENTS 6-3, 10-4](./REQUIREMENTS.md), [DATABASE 4-3, 7-3](./DATABASE.md) |

`point_logs`의 실제 기록·조회 역할도 함께 확인해야 합니다.

### P1-2. 미발급 주문 취소와 환불 정책 설정

| 필드 | 내용 |
|---|---|
| 우선순위 | P1 |
| 현재 상태 | **미완성** |
| 근거 파일 | `app/purchases/page.tsx`, `app/mypage/page.tsx`, `lib/orders.ts`, `lib/mypage.ts`, `add_refund_and_membership.sql` |
| 완료 조건 | 미발급 주문 취소 정책과 발급 후 환불 기간·사용 여부 정책을 확정하고, 회원·매니저 화면과 RPC가 같은 규칙을 사용하며 중복 환불을 차단함 |
| 관련 문서 | [REQUIREMENTS 6-1, 10-4](./REQUIREMENTS.md), [ROUTES `/purchases`](./ROUTES.md) |

현재 미발급 주문은 센터 문의로 안내하며 발급 후 환불은 24시간 이내·미사용 조건이 코드와 SQL에 고정되어 있습니다.

### P1-3. 외부 푸시·알림톡 발송

| 필드 | 내용 |
|---|---|
| 우선순위 | P1 |
| 현재 상태 | **미완성** |
| 근거 파일 | `app/settings/notifications/page.tsx`, `add_notifications.sql`, `schema.sql`; `messages`, `notification_rules`, `notification_logs` |
| 완료 조건 | 발송 채널과 opt-in 정책을 확정하고, 외부 발송기·재시도·실패 기록·수신 거부를 구현해 실제 기기 수신과 로그를 검증함 |
| 관련 문서 | [REQUIREMENTS 6-1](./REQUIREMENTS.md), [DATABASE 5절](./DATABASE.md), [ROUTES `/settings/notifications`](./ROUTES.md) |

현재 설정은 기기 `localStorage`에만 저장되며 실제 발송으로 이어지지 않습니다.

### P1-4. 네이버 소셜 로그인

| 필드 | 내용 |
|---|---|
| 우선순위 | P1 |
| 현재 상태 | **미완성** |
| 근거 파일 | `app/login/page.tsx`, `AUTH_SETUP.md` |
| 완료 조건 | 지원 여부와 인증 구조를 확정하고, callback·계정 생성·중복 이메일·실패 흐름을 staging에서 검증함. 미지원 결정 시 버튼과 문서를 일관되게 정리함 |
| 관련 문서 | [REQUIREMENTS 6-1](./REQUIREMENTS.md), [ROUTES `/login`](./ROUTES.md) |

현재 버튼은 미설정 안내만 표시합니다.

### P1-5. 매니저 세부 권한 기반 UI

| 필드 | 내용 |
|---|---|
| 우선순위 | P1 |
| 현재 상태 | **미완성** |
| 근거 파일 | `lib/roles.ts`, `app/manager/staff/permissions/page.tsx`, 전체 `app/manager/**/page.tsx`, `add_personal_permissions.sql` |
| 완료 조건 | 각 매니저 화면의 기능을 권한 키와 매핑하고 권한 없는 메뉴·버튼을 사전에 숨기거나 비활성화하며, RLS/RPC 거부도 그대로 유지해 역할별 검증을 통과함 |
| 관련 문서 | [REQUIREMENTS 5-7, 6-1](./REQUIREMENTS.md), [DATABASE 7-1, 10절](./DATABASE.md), [ROUTES 5절](./ROUTES.md) |

현재 `effectiveState()`는 권한 설정 화면에서만 사용되고 실제 기능 화면은 서버 거부 이후에야 권한 부족을 알 수 있습니다.

2026-08-01 Access Control 구현 Batch에서 1차 해결: `app/manager/page.tsx`의 13개 메뉴 중
권한 카탈로그에 대응 키가 있는 9개(수강권/진도표/스태프/매출/공지사항/문의/센터정보/룸/설정)를
`fetchMyEffectivePermissionKeys()` + `canSeeManagerMenu()`로 노출 제어함(오너는 전권, 비활성 시
서버 `has_permission()`과 동일한 우선순위로 판정). 나머지 4개(상품/후기/주문/관리자배치내역)는
카탈로그에 대응 permission key가 없어 이번 1차 범위에서 제외 — 새 permission key 추가는 스키마
변경이라 별도 승인 필요. `ManagerNav`의 4개 고정 탭(수업/회원/알림/더보기)도 아직 미검토. 개별
화면 내부의 버튼 단위 권한 표시(각 screen의 개별 액션 버튼)는 여전히 서버 거부 이후에야 알 수
있음 — 상세 내용은 [CHANGELOG.md](./CHANGELOG.md) 참고.

### P1-6. 관리자·운영자 클라이언트 가드 누락

| 필드 | 내용 |
|---|---|
| 우선순위 | P1 |
| 현재 상태 | **미완성** |
| 근거 파일 | `app/admin/categories/page.tsx`, `app/admin/banners/page.tsx`, `app/manager/inquiries/page.tsx`, `app/manager/notifications/page.tsx`, `app/manager/staff/permissions/page.tsx` |
| 완료 조건 | 플랫폼 운영자 2개 화면과 매니저 3개 화면에 일관된 사전 가드를 적용하고 비권한 사용자의 콘텐츠 미노출·친절한 오류·RLS 차단을 검증함 |
| 관련 문서 | [REQUIREMENTS 7~8절](./REQUIREMENTS.md), [ROUTES 5~7절](./ROUTES.md), [DATABASE 10절](./DATABASE.md) |

현재 데이터 쓰기는 RLS가 막지만 화면과 입력폼이 먼저 노출되는 페이지가 있습니다.

2026-08-01 Access Control 구현 Batch에서 완료: `app/admin/categories/page.tsx`,
`app/admin/banners/page.tsx`에 `/admin/centers`와 동일한 `checkPlatformAdmin()` 가드를 추가했고,
`app/manager/inquiries/page.tsx`, `app/manager/notifications/page.tsx`에는 `fetchMyCenters()` +
"운영 중인 센터가 없어요" 가드(기존 9개 화면과 동일한 패턴)를, `app/manager/staff/permissions/page.tsx`에는
URL의 `center` 파라미터로 현재 사용자가 그 센터의 오너인지 확인하는 가드(`isOwnerOfCenter()`)를
추가함. 상세 내용은 [CHANGELOG.md](./CHANGELOG.md) 참고. **클라이언트 가드는 완료했지만, 서버 측
재검증에서 `account_center_permissions`의 SELECT RLS 정책 자체가 "같은 센터 소속이면 누구나
조회 가능"하게 열려 있던 별도의 FAIL을 발견함** — 화면 가드와 무관하게 Supabase SDK 직접 호출로
우회 가능했던 서버 쪽 구멍. 수정 SQL 초안은 `fix_account_center_permissions_select_draft_proposed.sql`에
작성했으나 **아직 실행하지 않음**(이 PR에 포함 — ACL-003의 일부로 취급). 실행 전
`tests/integration/acl-003-permission-read.test.ts`를 통과시켜야 함. 이 SQL이 실제 실행되고
그 통합 테스트가 green이 될 때까지는 이 항목을 완전히 제거하지 말 것.

### P1-7. 국경일 자동 갱신

| 필드 | 내용 |
|---|---|
| 우선순위 | P1 |
| 현재 상태 | **미완성** |
| 근거 파일 | `app/reservation/page.tsx`, `lib/holidays.ts`; `PUBLIC_HOLIDAYS` |
| 완료 조건 | 승인된 공휴일 데이터 소스를 정하고 연도 변경에도 자동 조회·표시되며 센터 휴무일과 중복·충돌하지 않는지 검증함 |
| 관련 문서 | [REQUIREMENTS 5-2, 12절](./REQUIREMENTS.md), [ROUTES `/reservation`](./ROUTES.md) |

현재 국경일은 `2026-07-17` 제헌절 한 건만 하드코딩되어 있습니다.

### P1-8. 담당회원·상담고객 화면

| 필드 | 내용 |
|---|---|
| 우선순위 | P1 |
| 현재 상태 | **미완성 / 확인 필요** |
| 근거 파일 | `app/manager/members/page.tsx`, `schema.sql`; `leads`, `customer.lead.*` 권한 |
| 완료 조건 | 담당회원과 상담고객의 제품 정책·데이터 소유권·회원 전환 규칙을 확정하고 화면·lib·RLS를 연결해 CRUD를 검증함. 기능 제외 결정 시 준비 중 UI와 미사용 스키마 처리 방침을 기록함 |
| 관련 문서 | [REQUIREMENTS 6-1, 12절](./REQUIREMENTS.md), [DATABASE 5절](./DATABASE.md), [ROUTES `/manager/members`](./ROUTES.md) |

### P1-9. 관리자 직접배치 세부 permission key

| 필드 | 내용 |
|---|---|
| 우선순위 | P1 |
| 현재 상태 | **확인 필요 (제품 결정 대기)** |
| 근거 파일 | `add_admin_assignment.sql`(`can_manage_center_reservations()`), `lib/adminAssignment.ts`, `app/manager/classes/page.tsx` |
| 완료 조건 | `schedule.admin_assign`/`schedule.admin_free` 같은 세부 permission key를 `permissions` 카탈로그에 추가할지 결정하고, 추가한다면 `can_manage_center_reservations()` 내부에서 `has_permission()`을 함께 확인하도록 확장함. 결정 전에는 기존 `manager_book_member`와 동일하게 "센터 활성 매니저 OR 플랫폼 운영자" 전원이 이 기능을 쓸 수 있음을 화면·문서에 명시함 |
| 관련 문서 | [DATABASE 10절](./DATABASE.md), [REQUIREMENTS 10-1](./REQUIREMENTS.md) |

2026-07-30 사용자 확인: 이번 `feature/p1-reservation-ux` 범위에서는 새 permission key를 추가하지
않고, 권한 검사를 `can_manage_center_reservations()` 함수로 분리해 확장 지점만 마련하기로 결정함.

### P1-10. 관리자 직접배치 대상 회원 상태(이용정지/탈퇴/휴면) 차단 정책

| 필드 | 내용 |
|---|---|
| 우선순위 | P1 |
| 현재 상태 | **확인 필요 (제품 결정 대기)** |
| 근거 파일 | `add_admin_assignment.sql`(`is_profile_assignable()`), `schema.sql`(`center_members.status`: `active`/`expired`/`dormant`뿐, "이용정지"/"탈퇴"/"삭제" 상태값 자체가 없음) |
| 완료 조건 | 관리자 직접배치·무료 추가배치에서 차단해야 할 회원 상태 정책(이용정지/탈퇴/삭제/휴면 중 무엇을 막을지)을 결정하고, 필요한 상태값·컬럼을 새 migration으로 추가한 뒤 `is_profile_assignable()` 안에서 확인하도록 확장함 |
| 관련 문서 | [DATABASE 6절](./DATABASE.md) |

2026-07-30 사용자 확인: 이번 범위에서는 기존 `reserve_class`(회원 셀프예약)와 동일하게 이 개념을
새로 만들지 않기로 결정함(기존 셀프예약도 `center_members.status`를 확인하지 않음). 회원 자격
검사를 `is_profile_assignable()`로 분리해 향후 정책을 붙일 확장 지점만 마련함.

### P1-11. 관리자 직접배치 통합 테스트 — 정원 초과 확인(needs_capacity_confirm) 2단계 흐름 미검증

| 필드 | 내용 |
|---|---|
| 우선순위 | P2 |
| 현재 상태 | **미완성 (일부)** |
| 근거 파일 | `tests/integration/admin-assignment-security.test.ts`, `tests/integration/setup.ts` |
| 완료 조건 | `admin_assign_reservation`이 정원이 찬 수업에서 `needs_capacity_confirm: true`만 반환하고 예약을 만들지 않는지, 그 뒤 `p_force_capacity: true`로 재호출하면 `is_capacity_override: true`로 실제 생성되는지를 통합 테스트로 검증함(정원 1명짜리 테스트 수업을 만들어 확인 가능) |
| 관련 문서 | [tests/README.md](../tests/README.md) |

2026-07-30 갱신: 매니저 fixture 부재 문제는 `getOrCreateOwnedTestCenter()`(서비스 역할 키 없이
`centers`/`manager_centers` insert RLS만으로 테스트 계정이 스스로 오너가 되는 방식)로 해결되어,
사용자가 요청한 10개 성공 경로(ADMIN_ASSIGNMENT/ADMIN_FREE 정상 생성, 이용권 없음/만료 회원
성공, 취소 시 수강권 복구/미변화, `admin_action_logs`·회원 알림 생성, 동시 요청 단일 생성,
다른 센터 관리자 차단)는 모두 통합 테스트로 커버됨. 남은 것은 정원 초과 확인(1차 호출 저지 →
사유 입력 → `p_force_capacity`로 재호출) 2단계 흐름 자체의 자동화 테스트뿐 — 이번 범위에서는
수동으로만 확인함.

### P1-12. 운영설정(`/manager/settings`) 화면의 다수 항목이 저장만 되고 실제로 적용되지 않음

| 필드 | 내용 |
|---|---|
| 우선순위 | P1 |
| 현재 상태 | **8개 필드 SQL 실행 완료 + 회귀 테스트 8/8 green 확인(2026-08-02), 17개는 여전히 Dead Code** |
| 근거 파일 | `app/manager/settings/page.tsx`, `lib/settings.ts`, `wire_settings.sql`, `add_center_settings.sql`, `reservation_functions.sql`, `fix_settings_wire_reservation_logic_draft_proposed.sql`(신규), `docs/24_P1_12_Settings_Audit.md`(신규), `tests/integration/settings-reserve-class-wiring.test.ts`(신규) |
| 완료 조건 | `center_settings`의 각 필드가 실제로 어떤 RPC/쿼리에서 읽히는지 전수 확인하고, 미적용 필드는 (a) 해당 로직에 반영하거나 (b) "준비 중" 표시로 화면에서 명확히 구분함 |
| 관련 문서 | [23_Admin_Feature_Audit.md](./23_Admin_Feature_Audit.md) 운영설정 항목, [24_P1_12_Settings_Audit.md](./24_P1_12_Settings_Audit.md)(전체 34개 필드 표) |

2026-08-02 Track B 감사에서 발견: `center_settings`에 저장되는 34개 필드 중 예약 마감시각류
8개(`private/group_{book,cancel}_{days_before,time}`, `calc_deadline()`에서 사용)와
`deduct_on_late_cancel`(`cancel_reservation()`에서 사용) 9개만 실제로 어떤 서버 로직에서 읽힙니다.
나머지 25개는 `schema.sql`과 `lib/settings.ts` 외 코드 참조가 0건입니다 — 매니저가 화면에서
토글/숫자를 바꿔도 저장은 되지만 실제 예약·조회 흐름에는 아무 영향이 없습니다.

**2026-08-02 후속 배치에서 8개 필드 수정 SQL 작성 완료**: 전체 34개 필드를 개별 표로 다시
전수 조사(근거: [24_P1_12_Settings_Audit.md](./24_P1_12_Settings_Audit.md)). 그중 `reserve_class()`의
기존 동기 검증 흐름에 자연스럽게 추가 가능한 8개(`allow_same_day_booking`,
`daily_book_limit_enabled`/`daily_book_limit`, `waitlist_weekly_limit`,
`private_open_days_before`/`private_open_time`, `group_open_days_before`/`group_open_time`)를
`calc_deadline()`(`'open'` kind 추가)과 `reserve_class()`에 배선하는 SQL을
`fix_settings_wire_reservation_logic_draft_proposed.sql`(+ rollback 파일)로 준비했습니다 —
`reserve_class()`는 앱에서 가장 많이 호출되는 핵심 RPC라 P0-6보다 위험도가 높다고 판단해
파일 헤더에 별도 경고를 남겼습니다. **2026-08-02 SQL 실행 완료**(사용자 확인).

**2026-08-02 SQL 실행 후 재검증에서 테스트 fixture 자체의 설계 결함 2건 발견(SQL 문제 아님)**:
(1) `당일 예약 허용 여부` 테스트가 수업을 2시간 뒤(오늘)로만 만들어, 새로 배선한 same-day 체크에
도달하기도 전에 **기존** 예약 마감시간 체크(`group_book_days_before` 기본값 1일 → 마감이 항상
어제로 계산됨)에서 먼저 막힘 — `groupBookDaysBefore:0, groupBookTime:'23:59'` 오버라이드를
추가해 기존 체크를 통과시키고 same-day 체크만 단독으로 노출하도록 수정. (2) `daily_book_limit`은
그 프로필의 그 날짜 전체 예약을 합산하는데, 원래 파일의 여러 describe 블록(일일한도/대기/오픈시각)이
전부 비슷한 시간대(~50시간 뒤)를 재사용해 서로의 fixture 예약이 daily-limit 판정에 섞여 들어감 —
각 블록의 날짜를 16일/19일/25일/28일 뒤로 충분히 떨어뜨려 분리. `group_open_days_before` "아직
오픈 전" 케이스도 수업일이 오픈 기준일보다 더 멀리 있어야 함을 재확인해(수업 2일 뒤 + 10일 전
오픈 설정 = 오픈 시점이 이미 8일 전에 지나 오히려 "이미 열림"이 되는 반대 결과였음) 수업을 25일
뒤로 옮기고 오픈 기준을 15일 전으로 재조정. 회귀 테스트
`tests/integration/settings-reserve-class-wiring.test.ts`는 이 fixture 수정 이후 재검증했습니다.

**2026-08-02 CI에서 8/8 green 확인**: 위 fixture 수정들에 더해, 잔여 예약 정리 로직 자체의
버그도 추가로 발견해 고쳤습니다 — (1) `reservations`의 DELETE RLS 정책은 `cancelled`/`no_show`
상태만 삭제를 허용해 `confirmed`/`waitlisted` 상태로 직접 delete를 시도하면 조용히 0건이
지워지는 문제(반복 CI 재실행마다 잔여 예약이 쌓여 daily-limit/waitlist 판정을 오염시킴) —
`cancel_reservation()`으로 먼저 취소하도록 수정. (2) 잔여 정리 쿼리가 class id를 배열로 모아
`.in()`에 넘기다 이 테스트 센터에 쌓인 수백 건의 클래스 때문에 PostgREST가 "Bad Request"를
반환한 문제 — `classes!inner` 임베디드 조인으로 대체. (3) 당일(same-day) 테스트가 남긴 잔여
예약은 회원 셀프 취소 마감시간(기본 1일 전)이 항상 "어제"로 계산돼 `cancel_reservation()`으로
영영 취소할 수 없던 문제 — 매니저 권한으로 마감시간 검사 없이 처리하는
`manager_set_attendance(id,'cancelled')`로 교체. 이 모든 수정 후 CI에서
**8개 테스트 전부 green**을 확인했습니다 — P1-12 SQL(`fix_settings_wire_reservation_logic_draft_proposed.sql`)의
4개 기능(당일예약 허용/일일예약 한도/주간 대기예약 한도/예약 오픈 시각) 모두 정상 동작 확인됨.

나머지 17개(`same_day_change_hours/minutes`, `autocancel_hours/minutes`,
`waitlist_auto_hours/minutes`, `private_slot_unit`, `private_max_concurrent_enabled/_count`,
`show_group_reserved_count`/`show_group_waitlist_count`, `use_inquiry_board`, `show_all_classes`,
`use_locker`, `auto_unpaid_input`, `use_lounge`, `show_point_history`)는 이번 배치에서도 여전히
Dead Code로 남습니다 — 스케줄러 인프라 부재, 대응 UI/로직 자체 부재, 또는 다른 설정과의 의미
중복(제품 결정 필요) 때문입니다. 각 사유는 [24_P1_12_Settings_Audit.md](./24_P1_12_Settings_Audit.md)
표에 필드별로 기록했습니다. 이 17개를 실제로 구현할지, "준비 중"으로 화면에서 구분할지는
여전히 제품 결정이 필요합니다.

### P1-13. 센터정보(`/manager/center-info`) 수정 권한이 "오너 전용" 주석과 실제 RLS가 불일치

| 필드 | 내용 |
|---|---|
| 우선순위 | P1 |
| 현재 상태 | **확인됨 — RLS 변경 필요, 이번 배치 미수정** |
| 근거 파일 | `app/manager/center-info/page.tsx`, `reservation_functions.sql`("매니저 센터 수정" 정책) |
| 완료 조건 | `facility.info` 권한 세분화를 실제로 적용할지(RLS를 `has_permission(center_id,'facility.info')`로 좁힘) 아니면 코드 주석을 실제 동작("센터 소속 active 스태프면 누구나 가능")에 맞게 고칠지 결정하고 반영함 |
| 관련 문서 | [23_Admin_Feature_Audit.md](./23_Admin_Feature_Audit.md) 센터관리 항목 |

2026-08-02 Track B 감사에서 발견: `center-info/page.tsx` 상단 주석은 "시설 정보 설정 권한
(facility.info) 필요 — 오너는 항상 가능"이라고 적혀 있지만, 실제 RLS 정책(`"매니저 센터 수정"`,
`reservation_functions.sql`)은 `center_id in (select my_managed_center_ids())`만 확인합니다 —
오너가 아닌 일반 스태프도 센터 정보·결제수단·평판점수를 수정할 수 있어 주석과 실제 동작이
다릅니다. RLS 변경이 필요한 사안이라 Track B(SQL/RLS 변경 금지) 범위 밖입니다.

## 5. P2 — 운영 설정·개발환경·구조 검증

### P2-1. 카카오·애플 OAuth 운영 설정

| 필드 | 내용 |
|---|---|
| 우선순위 | P2 |
| 현재 상태 | **운영 설정 필요** |
| 근거 파일 | `app/login/page.tsx`, `AUTH_SETUP.md` |
| 완료 조건 | Supabase Provider, 각 제공자 설정, Redirect URL과 Vercel 환경을 구성하고 신규·기존 계정 로그인과 실패 callback을 검증함 |
| 관련 문서 | [REQUIREMENTS 5-1, 6-2](./REQUIREMENTS.md), [ROUTES `/login`](./ROUTES.md) |

### P2-2. Realtime publication과 문의·알림 RLS

| 필드 | 내용 |
|---|---|
| 우선순위 | P2 |
| 현재 상태 | **운영 설정 필요 / 확인 필요** |
| 근거 파일 | `lib/notifications.ts`, `lib/inquiries.ts`, `add_notifications.sql`, `add_inquiries.sql`; `notifications`, `inquiry_threads`, `inquiry_messages` |
| 완료 조건 | 운영 Supabase publication과 RLS를 확인하고 회원·매니저 양쪽에서 실시간 수신, 재구독, 권한 격리와 channel cleanup을 검증함 |
| 관련 문서 | [REQUIREMENTS 6-2](./REQUIREMENTS.md), [DATABASE 4-5, 12-5](./DATABASE.md), [ROUTES 알림·문의 항목](./ROUTES.md) |

### P2-3. Storage bucket과 정책 운영 확인

| 필드 | 내용 |
|---|---|
| 우선순위 | P2 |
| 현재 상태 | **운영 설정 필요 / 확인 필요** |
| 근거 파일 | `lib/storage.ts`, `lib/profiles.ts`, `lib/center.ts`, `lib/reviews.ts`, `setup_storage.sql`; `avatars`, `business-licenses` |
| 완료 조건 | 운영 bucket 존재, MIME·크기 정책, 업로드·조회·삭제 권한을 역할별로 검증하고 `business-licenses`가 비공개로 유지됨을 확인함 |
| 관련 문서 | [REQUIREMENTS 5-1, 6-2](./REQUIREMENTS.md), [DATABASE 4-7, 7-4](./DATABASE.md) |

### P2-4. 핵심 trigger 운영 적용 확인

| 필드 | 내용 |
|---|---|
| 우선순위 | P2 |
| 현재 상태 | **확인 필요** |
| 근거 파일 | `schema.sql`, `reservation_functions.sql`, `add_platform_admin.sql`, `add_notifications.sql`, `add_notification_triggers.sql` |
| 완료 조건 | 운영 `pg_trigger`에서 6개 trigger의 존재·활성 상태·대상 함수를 확인하고 센터 생성, 상태 변경, 주문·후기·예약 알림 시나리오를 검증함 |
| 관련 문서 | [DATABASE 11절, 12-5](./DATABASE.md) |

확인 대상:

- `trg_create_default_center_roles`
- `trg_guard_center_status`
- `notify_new_order`
- `notify_new_review`
- `notify_reservation_insert`
- `notify_reservation_update`

### P2-5. `revenue_summary` view 사용 여부

| 필드 | 내용 |
|---|---|
| 우선순위 | P2 |
| 현재 상태 | **확인 필요** |
| 근거 파일 | `schema.sql`, `lib/sales.ts`; `revenue_summary` |
| 완료 조건 | 운영·외부 리포트에서 view를 사용하는지 확인하고, 사용할 경우 코드·문서의 기준 집계로 연결해 결과를 검증함. 사용하지 않을 경우 보존·폐기 결정을 기록함 |
| 관련 문서 | [DATABASE 4-7](./DATABASE.md), [REQUIREMENTS 5-4](./REQUIREMENTS.md) |

SQL 정의는 있으나 현재 `app/`·`lib/`의 직접 조회는 확인되지 않았습니다.

### P2-6. `purchase_requests`의 현재 역할

| 필드 | 내용 |
|---|---|
| 우선순위 | P2 |
| 현재 상태 | **확인 필요** |
| 근거 파일 | `lib/center.ts`, `app/center/[id]/page.tsx`, `add_center_shop.sql`; `requestPurchase()`, `purchase_requests` |
| 완료 조건 | 장바구니·주문 이전 구매 신청 흐름을 계속 사용할지 결정하고 실제 호출자를 연결해 검증하거나, 대체 완료라면 운영 row·RPC·외부 접근을 확인한 뒤 보존·정리 방침을 기록함 |
| 관련 문서 | [DATABASE 4-3](./DATABASE.md), [ROUTES `/center/[id]`](./ROUTES.md) |

현재 insert helper는 존재하지만 센터 상세 화면은 `addToCart()`를 사용하며 `requestPurchase()` 호출은 확인되지 않았습니다.

### P2-7. `.env.local.example` 부재

| 필드 | 내용 |
|---|---|
| 우선순위 | P2 |
| 현재 상태 | **미완성** |
| 근거 파일 | `README.md`, `.gitignore`, `lib/supabaseClient.ts`; 저장소 루트에 `.env.local.example` 없음 |
| 완료 조건 | 실제 필요한 키 이름과 설명만 포함한 예제 또는 README 설치 절차를 마련하고, 새 환경에서 안내대로 실행해 앱이 시작됨. 비밀값은 포함하지 않음 |
| 관련 문서 | [REQUIREMENTS 6-2](./REQUIREMENTS.md), [DEVELOPMENT_RULES 11절](./DEVELOPMENT_RULES.md) |

### P2-8. Tailwind 설정과 실제 스타일 사용 불일치

| 필드 | 내용 |
|---|---|
| 우선순위 | P2 |
| 현재 상태 | **확인 필요** |
| 근거 파일 | `package.json`, `postcss.config.mjs`, `app/globals.css`, `app/layout.tsx`; Tailwind 패키지와 utility class는 있으나 CSS import 지시문 없음 |
| 완료 조건 | 브라우저 빌드 결과에서 Tailwind utility 생성 여부와 `app/layout.tsx`의 class 적용 여부를 확인하고, 사용한다면 현재 Next.js 구성에 맞게 활성화하거나 사용하지 않는다면 의존성과 죽은 utility class를 정리함 |
| 관련 문서 | [PROJECT_OVERVIEW 4절](./PROJECT_OVERVIEW.md), [DEVELOPMENT_RULES 3-3](./DEVELOPMENT_RULES.md) |

현재 저장소만 보면 Tailwind가 실제로 적용된 것으로 단정할 수 없습니다. 활성화 또는 제거 방향은 확인 없이 결정하지 않습니다.

### P2-9. 통합 테스트가 `lib/orders.ts`/`lib/payments`를 직접 import (기술 부채)

| 필드 | 내용 |
|---|---|
| 우선순위 | P2 |
| 현재 상태 | **확인 필요 (당장 문제 없음, 리팩터링 시 함께 검토)** |
| 근거 파일 | `tests/integration/payment-lifecycle.test.ts`, `tests/integration/payment-security.test.ts`, `lib/orders.ts`, `lib/payments/*` |
| 완료 조건 | `lib/orders.ts`(`createOrder` 등)의 시그니처나 동작을 바꿀 때, 통합 테스트가 실제 checkout 흐름을 그대로 검증한다는 장점을 유지하면서도 테스트가 매번 실서비스 코드 변경에 발이 묶이지 않도록 `tests/helpers`(또는 테스트 전용 헬퍼 계층)로 분리할지 결정하고 반영함 |
| 관련 문서 | [tests/README.md](../tests/README.md) |

지금은 의도적으로 `lib/orders.ts`/`lib/payments`의 **실제 함수**를 그대로 import해서 씁니다 —
checkout이 실제로 호출하는 코드와 동일한 경로를 검증한다는 장점이 있어 현재 구조에 문제는
없습니다. 다만 앞으로 `lib/orders.ts`를 리팩터링(시그니처 변경 등)하면 통합 테스트도 함께
영향을 받으므로, 그 시점에 테스트 전용 헬퍼 계층 분리 여부를 검토해야 합니다. 이번 작업
범위에서는 구조를 바꾸지 않습니다.

### P2-10. `tests/unit`이 mock 없이 import하면 `lib/supabaseClient.ts` 초기화까지 실행됨 (기술 부채)

| 필드 | 내용 |
|---|---|
| 우선순위 | P2 |
| 현재 상태 | **확인됨 — Node 22로 우회 완료, 근본 원인은 미해결** |
| 근거 파일 | `tests/unit/PaymentProviderFactory.test.ts`, `lib/payments/PaymentProviderFactory.ts`, `lib/payments/MockPaymentProvider.ts`, `lib/payments/mockPaymentApi.ts`, `lib/supabaseClient.ts` |
| 완료 조건 | `lib/payments/PaymentProviderFactory`/`MockPaymentProvider`가 실제 Supabase 클라이언트 생성과 완전히 분리되도록(예: RPC 호출부를 지연 import하거나, `PaymentProviderFactory` 테스트에서도 `mockPaymentApi`를 mock) 구조를 조정해, "Supabase가 필요 없는 단위 테스트"라는 전제가 import 체인만으로도 실제로 보장됨 |
| 관련 문서 | [tests/README.md](../tests/README.md), `.github/workflows/test.yml` |

2026-07-30에 GitHub Actions에서 `PaymentProviderFactory.test.ts`가 실패했습니다. 원인:
`@supabase/supabase-js`(하위 의존성 `realtime-js`)가 클라이언트 생성 시 native `WebSocket`
전역 객체를 요구하는데 Node 20에는 이게 없어, `getPaymentProvider()` → `MockPaymentProvider` →
`mockPaymentApi` → `lib/supabaseClient.ts`로 이어지는 import 체인이 테스트 시작 전에 그대로
실패했습니다. 로컬(Node 24)에는 native WebSocket이 있어 재현되지 않았습니다.

**임시 조치(완료)**: CI Node 버전을 20 → 22로 올려 우회했습니다(`.github/workflows/test.yml`,
`package.json`의 `engines.node`, `.nvmrc`). Node 22+에는 native WebSocket이 있어 지금은 통과합니다.

**근본 원인(미해결)**: `tests/unit/MockPaymentProvider.test.ts`는 `mockPaymentApi`를 `vi.mock()`으로
대체해 실제 `lib/supabaseClient.ts`가 전혀 로드되지 않지만, `PaymentProviderFactory.test.ts`는
mock 없이 실제 구현체를 그대로 import하기 때문에 "Supabase 접속이 필요 없는 단위 테스트"라는
설계 의도가 import 그래프상으로는 지켜지지 않고 있습니다. Node 버전에 우연히 기대는 구조라,
나중에 CI/로컬 Node 버전이 다시 낮아지거나 `realtime-js`가 WebSocket 요구사항을 더 엄격하게
바꾸면 같은 문제가 재발할 수 있습니다. 이번 작업에서는 Node 22 우회만 적용하고, 구조 분리는
하지 않았습니다.

### P2-11. 센터 등록(`registerCenterForAccount`)이 사업자등록번호 중복을 막지 않고 원자적이지 않음

| 필드 | 내용 |
|---|---|
| 우선순위 | P2 |
| 현재 상태 | **확인됨 — 기존부터 있던 상태를 그대로 유지, 이번 작업에서 새로 만들지 않음** |
| 근거 파일 | `lib/centers.ts`(`registerCenterForAccount`), `schema.sql`(`centers.business_number`) |
| 완료 조건 | 사업자등록번호 중복 등록을 막을지(막는다면 DB unique 제약 또는 사전 조회) 제품 결정을 받고, `centers`→`manager_centers`→역할 연결의 3단계 클라이언트 호출을 트랜잭션 RPC로 묶을지(SQL 변경 필요) 결정함 |
| 관련 문서 | [ACL-005/UI-003 완료 보고, 2026-08-02](./CHANGELOG.md) |

ACL-005/UI-003 작업 중 전수 조사하며 확인: `centers.business_number`에는 `unique` 제약이 없고,
애플리케이션 코드 어디에도 중복 검사가 없다(회원가입 매니저 흐름부터 그랬음 — 이번에 새로
만든 문제 아님). 또한 센터 등록은 `centers` insert → `manager_centers` insert → `center_roles`
조회 → `manager_centers` update(오너 role_id 연결) 4단계를 별도 요청으로 순차 호출하며, 트랜잭션으로
묶여 있지 않아 중간 단계 실패 시 부분적으로만 생성된 상태가 남을 수 있다(이번 작업에서 각 단계의
error를 무시하지 않고 사용자에게 표시하도록는 고쳤지만, 이미 커밋된 이전 단계를 되돌리지는
않는다). SQL 변경(unique 제약 또는 단일 RPC로 원자화)이 필요한 사안이라 이번 배치(SQL 실행 금지
지시)에서는 수정하지 않고 여기 기록만 한다.

### P2-12. SEC-007/008 RLS 정책 초안의 세부 결정 필요 항목

| 필드 | 내용 |
|---|---|
| 우선순위 | P2 |
| 현재 상태 | **확인 필요 (정책 초안은 존재, 실행 전 결정 필요)** |
| 근거 파일 | `add_rls_gap_tables_draft_proposed.sql`, [21_RLS_Gap_Analysis.md](./21_RLS_Gap_Analysis.md) |
| 완료 조건 | 아래 세부 항목을 결정한 뒤 `add_rls_gap_tables_draft_proposed.sql`을 반영해 실행함 |
| 관련 문서 | [21_RLS_Gap_Analysis.md](./21_RLS_Gap_Analysis.md) |

2026-08-01 SEC-007/008 조사 중 발견한, RLS 정책 자체보다 한 단계 더 결정이 필요한 항목들:

- `staff_salaries`에 급여 전용 `delete` permission key가 카탈로그에 없어 초안에서는 `.other.update`로
  대체함 — `facility.salary.setting`을 delete에 쓸지, 새 key를 추가할지 결정 필요.
- `contracts`/`membership_transfers`는 서명·잔여횟수 갱신처럼 원자적 처리가 필요해 직접 클라이언트
  INSERT/UPDATE보다 RPC(security definer) 경유가 안전함 — 초안은 임시로 권한 기반 INSERT만 열어뒀고
  UPDATE/DELETE는 막아뒀음. 실제 기능 구현 시 RPC로 전환할지 결정 필요.
- `community_comments`뿐 아니라 부모 `community_posts`도 조회 정책(`for select`) 1개만 있고
  쓰기(INSERT) 정책이 아예 없음 — 커뮤니티 기능을 실제로 켤 때 함께 보강해야 함.

### P2-13. service_role이 RLS Gap 17개 테이블(+`memberships`)에 대한 SQL GRANT가 없음(`contracts`/`notification_logs` 통합 테스트 자동화 불가)

| 필드 | 내용 |
|---|---|
| 우선순위 | P2 |
| 현재 상태 | **확인됨 — SQL 실행 필요, 이번 배치에서 실행하지 않음** |
| 근거 파일 | `tests/integration/sec009-batch-a1-rls.test.ts`, `tests/integration/setup.ts`(`describeAdminQueryError`), `tests/integration/holiday-membership-restore.test.ts`, `tests/integration/settings-reserve-class-wiring.test.ts` |
| 완료 조건 | `GRANT ALL ON TABLE contracts, notification_logs, memberships, ... TO service_role;`(대상 범위는 SEC-007 17개 테이블 + 이번에 새로 확인된 `memberships` 전체로 할지 결정) 실행을 사용자 승인 후 진행하고, `contracts`/`notification_logs`의 자동화된 통합 테스트를 추가함 |
| 관련 문서 | [21_RLS_Gap_Analysis.md](./21_RLS_Gap_Analysis.md) |

**2026-08-02 P0-6/P1-12 배치 CI 첫 실행에서 추가 확인**: `memberships`도 같은 패턴(`permission
denied for table memberships`)임을 새로 발견했습니다 — SEC-007 17개 테이블 목록에는 없던
테이블입니다. `memberships`는 매니저 계정(로그인 세션, RLS "매니저 수강권 발급"/"매니저 수강권
조회" 정책)으로 INSERT/SELECT는 가능해 fixture 생성 자체는 막히지 않지만, **DELETE 정책이
아예 없어**(payments/orders와 동일 패턴) 매니저 세션으로도 service_role로도 지울 수 없습니다.
`tests/integration/holiday-membership-restore.test.ts`/`settings-reserve-class-wiring.test.ts`는
이 사실을 반영해 memberships fixture를 정리하지 않고 잔존시키도록 수정했습니다(기존
`admin-assignment-security.test.ts`와 동일 관례).

SEC-009(Batch A 적용 준비) 중 발견: RLS 정책 부재와는 별개로, `staff_salaries`/`contracts`/
`leads`/`messages`/`notification_logs` 5개 테이블 전부 `service_role`에 SQL GRANT 자체가 없다
(`account_center_permissions`에서 이미 한 번 겪은 것과 같은 패턴, `permission denied for table X`).
`staff_salaries`/`leads`/`messages`는 오너에게 INSERT+DELETE 정책이 모두 있어 일반 로그인
client로 fixture를 만들고 지울 수 있어 문제가 되지 않지만, `contracts`(DELETE 정책이 의도적으로
없음 — 서명 후 불변)와 `notification_logs`(INSERT 정책이 의도적으로 없음 — 서버 트리거 전용)는
일반 client로도 admin client로도 fixture를 만들거나 지울 방법이 현재 없다. 이 두 테이블의
자동화된 통합 테스트는 이 GRANT가 해결된 뒤에만 안전하게 추가할 수 있다 — 그때까지는
`tests/integration/sec009-batch-a1-rls.test.ts`에서 의도적으로 제외했다.

### P2-14. Track B 감사에서 발견한 그 외 소규모 항목 모음

| 필드 | 내용 |
|---|---|
| 우선순위 | P2 |
| 현재 상태 | **확인됨 — 대부분 SQL/RLS 변경 필요, 이번 배치 미수정** |
| 근거 파일 | `lib/classes.ts`, `app/manager/staff/permissions/page.tsx`, `lib/progress.ts`, `add_membership_rules.sql`, `add_rooms_fix.sql` |
| 완료 조건 | 항목별로 개별 판단(아래 참고) — 하나의 완료 조건으로 묶이지 않음, 필요시 개별 TODO로 승격 |
| 관련 문서 | [23_Admin_Feature_Audit.md](./23_Admin_Feature_Audit.md) |

2026-08-02 Track B 감사에서 발견했지만 개별 P0-P1으로 승격하기엔 영향이 작거나 제품 판단이
먼저 필요한 항목들:
- `lib/classes.ts`의 구버전 `previewCopySchedule`/`copySchedule`(nth-weekday 방식)이 화면에서
  더 이상 호출되지 않는 죽은 코드로 남아있음 — 제거 검토.
- 반복수업 생성(`perDayMode`)과 `updateClassGroup`이 여러 행을 순차 처리해 원자성이 없음(중간
  실패 시 일부만 반영) — RPC로 묶을지 판단 필요(SQL).
- `app/manager/staff/permissions/page.tsx`의 클라이언트 가드(오너만 진입 가능)와 서버 쓰기
  정책(`facility.role_permission` 보유자도 가능)이 불일치 — 오너가 그 권한을 다른 매니저에게
  줘도 그 매니저는 화면에 못 들어감(RLS/화면 로직 중 하나를 맞출지 판단 필요).
- `membership_schedule_rules`는 `pass.update` 권한을 요구하는데 메뉴 게이트는 `pass.create`만
  확인 — 권한 카탈로그 정합성 재검토 필요(SQL 또는 메뉴 게이트 키 변경).
- `progress_records`에 UPDATE RLS 정책 자체가 없음(SELECT/INSERT/DELETE만 존재) — 현재는
  호출하는 코드가 없어 무해하지만(관련 죽은 import는 이번에 제거함), 나중에 수정 기능을 추가하면
  RLS부터 필요(SQL).
- `rooms` SELECT가 `using (true)`로 로그인 없이도 전체 공개 — 의도된 것인지 확인 필요(PII 아님,
  낮은 위험이지만 미확인 상태).

### P2-15. 통합 테스트 계정 중 플랫폼 운영자 자격이 있는 계정이 없어 `reserve_class()`를 직접 검증하는 CI 테스트가 항상 막힘

| 필드 | 내용 |
|---|---|
| 우선순위 | P2 |
| 현재 상태 | **해결됨 — 2026-08-02 SQL 실행 완료, CI에서 센터 승인 상태 확인됨** |
| 근거 파일 | `tests/integration/settings-reserve-class-wiring.test.ts`, `reservation_functions.sql`(`guard_center_status_change()`), `tests/integration/setup.ts`(`getOrCreateOwnedTestCenter`), `fix_test_center_approval_draft_proposed.sql`(신규) |
| 완료 조건 | (a) `TEST_MANAGER_A`의 테스트 센터를 Supabase에서 1회 수동으로 `status='approved'`로 바꾸거나, (b) 플랫폼 운영자 권한을 가진 전용 테스트 계정을 추가해 그 계정으로 승인 처리하도록 fixture를 확장함 |
| 관련 문서 | [TODO.md P1-12](#p1-12-운영설정manager-settings-화면의-다수-항목이-저장만-되고-실제로-적용되지-않음) |

2026-08-02 P1-12 SQL 준비 중 CI에서 발견: `getOrCreateOwnedTestCenter()`가 새로 만드는 테스트
센터는 기본 `status='pending'`인데, `guard_center_status_change()` 트리거가
`is_platform_admin()`이 아니면 이 값을 바꾸는 UPDATE를 전부 막습니다(service_role/admin
client의 UPDATE도 예외 없이 막힘 — RLS가 아니라 트리거 레벨 검증이라 우회 불가). 지금까지의
모든 통합 테스트는 `admin_assign_reservation` 등 관리자 전용 RPC만 썼거나 미리 승인된
`TEST_CENTER_ID`(레거시 checkout 흐름 전용, managerA 소유 아님)만 써서 이 gap이 드러나지
않았습니다. `settings-reserve-class-wiring.test.ts`가 이 저장소에서 처음으로 회원 셀프예약
RPC(`reserve_class`)를 직접 호출하는 통합 테스트라 이 gap이 드러났습니다. 이 항목이 해결되기
전까지는 `settings-reserve-class-wiring.test.ts`가 P1-12 SQL 적용 여부와 무관하게 항상
"테스트 센터를 승인 상태로 바꿀 수 없어요" 에러로 막힙니다 — SQL 자체의 결함이 아닙니다.

**2026-08-02 수정 준비 완료**: `guard_center_status_change()` 트리거가 `before update`에만
걸려 있고 `insert`는 막지 않는다는 점을 확인해, `tests/integration/setup.ts`의
`getOrCreateOwnedTestCenter()`가 **새 센터를 처음부터 `status='approved'`로 insert**하도록
수정했습니다(코드 변경, SQL 아님 — 이미 반영됨). 다만 `TEST_MANAGER_A`처럼 과거 배치에서 이미
`status='pending'`으로 만들어진 기존 센터를 계속 재사용하는 계정은 이 코드 수정만으로는
바뀌지 않습니다 — 그 기존 행들을 한 번 승인 처리하는 `fix_test_center_approval_draft_proposed.sql`(+
rollback)을 준비했습니다. `통합테스트센터-` 이름 접두사로 좁혀 실제 운영 센터에는 영향이
없고, `trg_guard_center_status` 트리거를 트랜잭션 안에서 잠깐 껐다 켜는 방식입니다.

**2026-08-02 SQL 실행 완료(사용자 확인) 및 CI로 검증**: 실행 후 CI를 재실행한 결과
`settings-reserve-class-wiring.test.ts`의 beforeAll이 더 이상 "테스트 센터를 승인 상태로
바꿀 수 없어요" 에러로 막히지 않고, 8개 개별 테스트가 실제로 전부 실행됨을 확인했습니다
(이전에는 beforeAll에서 즉시 실패해 7개가 skip 처리됐음). **이 항목은 해결되었습니다.**

## 6. P3 — 제품 결정이 필요한 향후 기능 후보

아래 항목은 스키마 또는 권한 근거만 있고 완성된 앱 흐름이 없습니다. 사용자·제품 결정 없이 구현 또는 삭제하지 않습니다.

### P3-1. 수업 구분과 복수 강사 배정

| 필드 | 내용 |
|---|---|
| 우선순위 | P3 |
| 현재 상태 | **확인 필요** |
| 근거 파일 | `schema.sql`, `reservation_functions.sql`, `lib/classes.ts`; `class_types`, `class_trainers`, `classes.class_type_id` |
| 완료 조건 | 두 기능의 제품 포함 여부를 결정함. 포함 시 수업 CRUD·권한·기존 수업 migration을 구현하고, 제외 시 FK·운영 데이터·외부 사용을 확인한 정리 계획을 승인받음 |
| 관련 문서 | [REQUIREMENTS 6-3, 12절](./REQUIREMENTS.md), [DATABASE 5절](./DATABASE.md) |

### P3-2. 락커와 수강권 양도

| 필드 | 내용 |
|---|---|
| 우선순위 | P3 |
| 현재 상태 | **확인 필요** |
| 근거 파일 | `schema.sql`, `app/manager/settings/page.tsx`; `lockers`, `locker_assignments`, `membership_transfers`, `center_settings.use_locker`, `payments.sale_type = transfer_fee` |
| 완료 조건 | 락커 배정과 양도의 정책·과금·이력 요구를 결정함. 포함 시 UI·lib·RPC·RLS를 연결하고, 제외 시 설정·상태값·운영 데이터 정리 방침을 승인받음 |
| 관련 문서 | [REQUIREMENTS 6-3, 12절](./REQUIREMENTS.md), [DATABASE 5절](./DATABASE.md) |

### P3-3. 회원 커스텀 필드

| 필드 | 내용 |
|---|---|
| 우선순위 | P3 |
| 현재 상태 | **확인 필요** |
| 근거 파일 | `schema.sql`, `reservation_functions.sql`; `center_member_fields`, `profile_center_fields` |
| 완료 조건 | 센터 정의 필드와 회원 입력값의 노출·수정 권한을 결정하고 실제 설정·입력 화면을 구현하거나 미사용 결정을 기록함 |
| 관련 문서 | [DATABASE 5절](./DATABASE.md), [REQUIREMENTS 12절](./REQUIREMENTS.md) |

### P3-4. 커뮤니티·대회정보·팝업공지

| 필드 | 내용 |
|---|---|
| 우선순위 | P3 |
| 현재 상태 | **확인 필요** |
| 근거 파일 | `schema.sql`; `community_posts`, `community_comments`, `competitions`, `popup_notices` |
| 완료 조건 | 각 기능의 로드맵 포함 여부, 사용자 유형, moderation·공개 범위를 결정함. 포함 시 실제 route·lib·RLS를 구현하고 제외 시 보존·정리 결정을 기록함 |
| 관련 문서 | [REQUIREMENTS 6-3, 12절](./REQUIREMENTS.md), [DATABASE 5절](./DATABASE.md), [21_RLS_Gap_Analysis.md](./21_RLS_Gap_Analysis.md) |

2026-08-01 SEC-007/008 조사: 네 테이블 모두 app/lib 코드 참조 0건(미구현 확정), RLS도 없거나
정책 0건(`community_posts`만 SELECT 정책 1개 존재, 자식 `community_comments`는 그마저 없음). RLS
정책 초안은 `add_rls_gap_tables_draft_proposed.sql`에 작성해둠(미실행). 로드맵 포함 여부 결정은
여전히 이 항목의 범위임 — 정책 초안은 "포함하기로 결정될 경우" 바로 쓸 수 있도록 준비한 것.

### P3-5. 스태프 급여·근무일정과 전자계약

| 필드 | 내용 |
|---|---|
| 우선순위 | P3 |
| 현재 상태 | **확인 필요** |
| 근거 파일 | `schema.sql`; `staff_salaries`, `staff_schedules`, `schedule_memos`, `contract_templates`, `terms`, `contracts`, 관련 `permissions` |
| 완료 조건 | 급여·일정·계약의 법적·제품 범위와 접근 권한을 결정함. 포함 시 감사 이력·서명·개인정보 보호를 포함한 전체 흐름을 구현하고, 제외 시 스키마 처리 방침을 승인받음 |
| 관련 문서 | [REQUIREMENTS 6-3, 12절](./REQUIREMENTS.md), [DATABASE 5절](./DATABASE.md), [21_RLS_Gap_Analysis.md](./21_RLS_Gap_Analysis.md) |

2026-08-01 SEC-007/008 조사: 여섯 테이블 모두 미구현(코드 참조 0건), RLS 없음. 그중
`staff_salaries`(급여)와 `contracts`(서명 이미지 포함 계약서)는 이번 배치 우선순위 분류에서
**Critical**로 표시함 — 로드맵에 포함하기로 결정되는 즉시(코드가 이 테이블을 건드리기 전에)
RLS부터 적용해야 함. 정책 초안은 `add_rls_gap_tables_draft_proposed.sql`에 준비해둠(미실행).

### P3-6. 알림 규칙·발송 로그, 상담 채널, 스케줄 템플릿

| 필드 | 내용 |
|---|---|
| 우선순위 | P3 |
| 현재 상태 | **확인 필요** |
| 근거 파일 | `schema.sql`, `reservation_functions.sql`; `notification_rules`, `notification_logs`, `messages`, `center_contacts`, `schedule_templates` |
| 완료 조건 | 현재 알림·센터 정보·`CopyCalendar`와 각 객체의 역할을 비교해 중복 여부를 결정함. 사용할 경우 화면·처리 흐름을 연결하고, 사용하지 않을 경우 운영 데이터 확인 후 정리 계획을 승인받음 |
| 관련 문서 | [DATABASE 5절](./DATABASE.md), [REQUIREMENTS 12절](./REQUIREMENTS.md), [21_RLS_Gap_Analysis.md](./21_RLS_Gap_Analysis.md) |

2026-08-01 SEC-007/008 조사: `messages`(대량 SMS/푸시 발송, `target_profile_ids[]` 배열 포함)와
`notification_logs`(발송 정산 기록)는 코드 참조 0건에 RLS 없음을 확인. `messages`는 회원과의
1:1 채팅(`inquiry_messages`)이나 자동알림(`notification_rules`)과는 목적이 다른 "대량 발송"
전용 테이블이라 중복이 아니라 미구현 기능임(`message.sms.*`/`message.push.*` 권한이 카탈로그에
이미 있음). 정책 초안은 `add_rls_gap_tables_draft_proposed.sql`에 준비해둠(미실행).

## 7. P3 — 용도·존속 여부가 불명확한 객체

### P3-7. `product_passes`

| 필드 | 내용 |
|---|---|
| 우선순위 | P3 |
| 현재 상태 | **확인 필요** |
| 근거 파일 | `schema.sql`, 현재 앱의 `products`·`memberships` 사용 코드 |
| 완료 조건 | 운영 데이터·RPC·외부 도구 사용 여부를 확인하고 `memberships`와 다른 역할이 있는지 결정함. 보존 또는 제거 결정을 기록함 |
| 관련 문서 | [DATABASE 6절](./DATABASE.md) |

### P3-8. `change_logs`

| 필드 | 내용 |
|---|---|
| 우선순위 | P3 |
| 현재 상태 | **확인 필요** |
| 근거 파일 | `schema.sql`; 앱 호출·핵심 trigger 미확인 |
| 완료 조건 | 운영 감사 로그로 사용되는지 확인하고 기록 주체·보존 기간을 결정함. 미사용이면 운영 데이터 확인 후 정리 계획을 승인받음 |
| 관련 문서 | [DATABASE 6절](./DATABASE.md), [21_RLS_Gap_Analysis.md](./21_RLS_Gap_Analysis.md) |

2026-08-01 SEC-007/008 조사: app/lib 전체와 모든 SQL 함수/트리거/뷰에서 참조 0건 재확인. 기록하는
주체(트리거 등)가 아직 아예 없어 완전히 빈 테이블로 추정됨. RLS도 없음 — 조회 전용 정책 초안을
`add_rls_gap_tables_draft_proposed.sql`에 준비해둠(미실행). "미사용이면 정리"보다는, 원래 의도된
변경이력 감사 기능을 실제로 만들지 여부가 먼저 결정돼야 함(만들기로 하면 트리거 작성 필요).

### P3-9. 구버전 가능성이 있는 `chat_messages`와 `reviews`

| 필드 | 내용 |
|---|---|
| 우선순위 | P3 |
| 현재 상태 | **확인 필요** |
| 근거 파일 | `schema.sql`, `fix_center_reviews.sql`, `lib/inquiries.ts`, `lib/reviews.ts`; 현재 앱은 `inquiry_messages`, `center_reviews` 사용 |
| 완료 조건 | 운영 row, RPC·trigger·외부 접근을 확인해 대체 완료 여부를 확정함. 데이터 migration·보관·삭제 계획을 사용자 승인 후 수행함 |
| 관련 문서 | [DATABASE 6절, 10-3](./DATABASE.md), [REQUIREMENTS 6-3](./REQUIREMENTS.md) |

2026-08-01 DB-001 조사 결론(`chat_messages`만 — `reviews` 쪽은 이번 조사 범위 아님): app/lib 전체와
모든 SQL 함수/트리거/뷰에서 참조 0건. RLS는 활성화되어 있으나 정책이 0건이라 현재는 anon/authenticated
누구도 접근할 수 없는 상태(안전하지만 기능도 불가). 1:1 채팅은 `inquiry_threads`/`inquiry_messages` +
RPC(`open_inquiry_thread`/`send_inquiry_message`/`read_inquiry_thread`) + 실시간 구독으로 완전히
대체되어 있음을 확인함. **결론: 정책 추가 후보가 아니라 삭제 후보.** 이번 배치는 실제 DROP을
하지 않음 — 사용자 승인 후 별도 배치에서 `chat_messages` DROP 마이그레이션을 작성할 것.

## 8. 상태 갱신 체크리스트

항목을 완료로 바꾸기 전에 다음을 확인합니다.

- [ ] 완료 조건의 모든 문장을 실제로 검증했다.
- [ ] 코드 변경은 build와 관련 수동 테스트를 통과했다.
- [ ] SQL 파일 생성과 운영 Supabase 적용을 구분했다.
- [ ] 운영 객체는 `pg_get_functiondef`, `pg_policies`, `pg_trigger` 등 실제 상태를 확인했다.
- [ ] OAuth·Realtime·Storage·scheduler는 운영 또는 staging 설정을 확인했다.
- [ ] 회원·스태프·매니저·오너·플랫폼 운영자 권한을 필요한 범위에서 검증했다.
- [ ] 데이터 migration과 기존 row 영향을 확인했다.
- [ ] 사용자 결정이 필요한 항목은 결정 근거를 기록했다.
- [ ] REQUIREMENTS·DATABASE·ROUTES의 상태를 함께 갱신했다.
- [ ] CHANGELOG에 날짜, 변경, 검증 결과를 기록했다.
- [ ] 완료되지 않은 하위 작업을 숨기지 않고 별도 TODO로 남겼다.
