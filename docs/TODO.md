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

**2026-08-04 갱신**: `reserve_with_membership`은 실제로 운영설정 가드(당일예약/일일한도/
오픈·마감/시작후차단/휴무일)가 전혀 없는 상태였음을 코드+실제 브라우저 재현으로 확인—
`reserve_class`에만 있던 가드가 이식된 적이 없었다(실제 회원 화면은 수강권이 있으면
`reserve_with_membership`을 호출하므로 실사용에 영향 있었음). `fix_reserve_with_membership_operational_settings.sql`로
수정, 사용자가 운영 DB에 적용 완료. `fix_usable_memberships_product_kind.sql`도 이번에
같이 적용 완료(적용 전엔 "사용 가능한 수강권" 목록에 goods 상품이 섞여 보이는 상태였음).
남은 미확인 RPC: `fulfill_order`/`manager_set_attendance`/`auto_book_membership`/
`has_permission`/`is_platform_admin` — 이번 세션에서 다루지 않음.

**2026-08-07 갱신(P3 출석 배치)**: `manager_set_attendance`는 저장소 안에 서로 다른 버전이
4곳에 정의돼 있어(`add_attendance.sql` v1, `reservation_functions.sql` 안에 v1 중복 + v2,
`add_admin_assignment.sql` v4) 어느 게 라이브인지 알 수 없던 상태였다.
`fix_attendance_consolidate_and_guard_draft_proposed.sql`로 v4를 base로 유일한 정의로
통합하고, 감사에서 발견한 실제 버그(대기 예약도 출석 처리 가능)를 함께 고쳤다 —
**2026-08-07 사용자가 운영 DB에 적용 완료, `pg_get_functiondef`로 확인됨** — 이제 이 RPC는
"확인 필요" 목록에서 제외한다.
"지각(late)" 상태는 스키마(`reservations.status` check 제약)에 아예 없고, 이번 MVP 요청도
"최소 상태 관리"였던 점을 감안해 추가하지 않았다 — 필요하면 CHECK 제약 확장 + RPC 분기 +
양쪽 관리자 UI 수정이 필요한 별도 제품 결정.

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
| 현재 상태 | **확인됨 — SQL(RPC) 수정 필요, Track B 규칙상 이번 배치 미수정** |
| 근거 파일 | `reservation_functions.sql`(`add_holiday_safe` 함수), `app/manager/holidays/page.tsx` |
| 완료 조건 | `add_holiday_safe`가 확정/대기/출석 예약을 강제 취소할 때 `admin_cancel_reservation`/`manager_set_attendance`와 동일하게 `memberships.remaining_count`를 복구하도록 RPC를 수정하고, 예약자 있는 날짜를 휴무일로 지정하는 통합 테스트로 회귀 확인함 |
| 관련 문서 | [23_Admin_Feature_Audit.md](./23_Admin_Feature_Audit.md) 8번 항목 |

2026-08-02 Track B 관리자 기능 감사에서 발견: 매니저가 예약자가 있는 날짜를 휴무일로 지정하면
`add_holiday_safe`가 해당 예약들을 강제로 지우면서(`delete from reservations`) 그 예약에 쓰인
수강권의 `remaining_count`를 전혀 복구하지 않습니다. 같은 "취소" 성격의 다른 경로
(`admin_cancel_reservation`, `manager_set_attendance`의 취소 처리)는 전부 정확히 +1 복구하는
것과 대조적입니다 — 회원이 수강권 횟수를 영구히 잃는 실질적 금전/재화 손실 버그입니다.
RPC(SQL) 수정이 필요해 Track B("SQL 실행 금지·새 RLS 수정 금지·DB 변경 금지") 범위 밖이라
이번 배치에서는 고치지 않고 여기 기록만 합니다 — 별도 승인된 SQL 배치에서 처리해야 합니다.
부수 발견: 같은 함수가 권한 체크에 `schedule.own.group.delete`(원래 "수업그룹 삭제" 용도)
권한 키를 재사용하고 있어, 세분권한 도입 시 의미가 부정확할 수 있습니다(이것도 SQL 필요).

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

2026-08-05 P2(프라이빗 수업) 감사 중 갱신: 프라이빗(1:1) 수업에 대해서는 이 2단계 흐름 자체가
잘못돼 있었다 — `p_force_capacity=true`로 재호출하면 그룹 수업과 구분 없이 그대로 두 번째
확정 예약을 만들어 "1:1"이 깨졌다. `fix_private_class_capacity_and_concurrency_draft_proposed.sql`
(SQL 미적용, 승인 대기)로 프라이빗 수업은 이 override 자체를 거부하도록 수정하고
`tests/integration/private-class-capacity.test.ts`로 검증 추가. 그룹 수업의 정상 2단계
흐름(확인→재호출로 실제 생성) 자체를 검증하는 테스트는 여전히 없음 — 이 항목은 그 부분만
남은 것으로 범위를 좁힘.

### P1-12. 운영설정(`/manager/settings`) 화면의 다수 항목이 저장만 되고 실제로 적용되지 않음

| 필드 | 내용 |
|---|---|
| 우선순위 | P1 |
| 현재 상태 | **부분 구현 — 화면은 완료, 서버 적용은 일부만** |
| 근거 파일 | `app/manager/settings/page.tsx`, `lib/settings.ts`, `wire_settings.sql`, `add_center_settings.sql`, `reservation_functions.sql` |
| 완료 조건 | `center_settings`의 각 필드가 실제로 어떤 RPC/쿼리에서 읽히는지 전수 확인하고, 미적용 필드는 (a) 해당 로직에 반영하거나 (b) "준비 중" 표시로 화면에서 명확히 구분함 |
| 관련 문서 | [23_Admin_Feature_Audit.md](./23_Admin_Feature_Audit.md) 운영설정 항목 |

2026-08-02 Track B 감사에서 발견: `center_settings`에 저장되는 약 26개 필드 중 예약 마감시각류
8개(`private/group_{book,cancel}_{days_before,time}`, `calc_deadline()`에서 사용)와
`deduct_on_late_cancel`(`cancel_reservation()`에서 사용) 9개만 실제로 어떤 서버 로직에서 읽힙니다.
나머지(`allow_same_day_booking`, `daily_book_limit(_enabled)`, `waitlist_auto_hours/minutes`,
`waitlist_weekly_limit`, `use_locker`, `use_lounge`, `private_max_concurrent(_enabled)`,
`show_group_reserved_count`/`show_group_waitlist_count`, `use_inquiry_board`, `show_all_classes`,
`auto_unpaid_input`, `show_point_history` 등)는 `schema.sql`과 `lib/settings.ts` 외 코드 참조가
0건입니다 — 매니저가 화면에서 토글/숫자를 바꿔도 저장은 되지만 실제 예약·조회 흐름에는
아무 영향이 없습니다. 신뢰를 해치는 문제라 P1로 분류합니다. 각 필드를 실제로 구현할지,
아니면 "준비 중"으로 화면에서 구분할지는 제품 결정이 필요합니다.

2026-08-05 P2(프라이빗 수업) 감사에서 `private_max_concurrent(_enabled)`는 해결: reserve_class/
reserve_with_membership/admin_assign_reservation에 "같은 센터·같은 시간대에 확정된 다른
프라이빗 수업 수"를 세어 한도를 넘으면 거부하는 로직을 추가했다
(`fix_private_class_capacity_and_concurrency_draft_proposed.sql`, SQL 미적용·승인 대기,
`tests/integration/private-class-capacity.test.ts`로 검증). 목록에서 이 필드는 제거하되,
`private_slot_unit`(schema.sql에만 있고 코드 참조 0건, 프라이빗 시간 단위 슬롯 선택 UI 자체가
없어 죽은 설정으로 보임)은 여전히 미해결 — P2/P3 후속 범위(프라이빗 셀프 슬롯 예약 UI를
만들지 여부와 함께 제품 결정 필요)로 남긴다.

### P1-13. (2026-08-14, 완료) 센터정보(`/manager/center-info`) 수정 권한이 "오너 전용" 주석과 실제 RLS가 불일치

| 필드 | 내용 |
|---|---|
| 우선순위 | P1 |
| 현재 상태 | **완료 — 두 세션이 같은 티켓을 서로 다른 레이어에서 손대 합쳐짐(겹치지 않고 서로 보완).** |
| 근거 파일 | `app/manager/center-info/page.tsx`, `reservation_functions.sql`("매니저 센터 수정" 정책), `fix_centers_update_facility_info_permission.sql`(다른 세션, PR #54, 적용 완료), `fix_center_info_sensitive_fields_permission_draft_proposed.sql`(이 세션, 적용 완료) |
| 완료 조건 | ~~`facility.info` 권한 세분화를 실제로 적용할지 결정하고 반영함~~ 완료. |
| 관련 문서 | [23_Admin_Feature_Audit.md](./23_Admin_Feature_Audit.md) 센터관리 항목 |

2026-08-02 Track B 감사에서 발견: `center-info/page.tsx` 상단 주석은 "시설 정보 설정 권한
(facility.info) 필요 — 오너는 항상 가능"이라고 적혀 있지만, 실제 RLS 정책(`"매니저 센터 수정"`,
`reservation_functions.sql`)은 `center_id in (select my_managed_center_ids())`만 확인했습니다 —
오너가 아닌 일반 스태프도 센터 정보·결제수단·평판점수를 수정할 수 있었습니다.

**2026-08-14 최종 확정(두 레이어)**: `facility.info` 권한 키는 이미 `schema.sql`에 정의돼
있었고 `app/manager/page.tsx`의 메뉴 노출도 이미 `canSeeMenu("facility.info")`로 가려져
있었지만(URL 직접 접근만 뚫려있었음), RLS 자체가 이를 확인 안 하고 있었습니다.
- (다른 세션, PR #54) "매니저 센터 수정" RLS를 `has_permission(id,'facility.info') OR
  is_platform_admin()`으로 좁힘 — facility.info 없으면 이 화면 전체(소개글/주소/전화 포함)
  저장이 막힘. 사용자가 `fix_centers_update_facility_info_permission.sql` 적용, `pg_policies`
  재조회로 확인.
- (이 세션) 그 위에 결제수단(pay_methods)/후기 적립 포인트(review_point) 두 필드는 한 단계
  더 좁혀 오너 또는 `facility.paymethod` 권한 보유자만(결제수단), 오너 전용(포인트, 대응
  permission key 없음)으로 추가 제한 — `guard_center_sensitive_fields_change` BEFORE UPDATE
  트리거(`fix_center_info_sensitive_fields_permission_draft_proposed.sql`)로 구현. "facility.info는
  위임했지만 결제수단/포인트까지는 아직" 같은 세분화된 위임을 가능하게 하는 게 목적이라
  facility.info 체크와 중복이 아님. 사용자가 SQL Editor에서 적용, `pg_trigger` 재조회로 확인.
  `app/manager/center-info/page.tsx`도 `fetchMyEffectivePermissionKeys`로 미리 계산해 권한
  없는 필드/전체 저장을 UI에서부터 비활성화·안내하도록 갱신(DB 레이어가 최종 방어선, UI는 편의).

## 5. P2 — 운영 설정·개발환경·구조 검증

### P2-1. 구글·카카오·애플 OAuth 운영 설정 (네이버는 별도 Edge Function 필요)

| 필드 | 내용 |
|---|---|
| 우선순위 | P2 |
| 현재 상태 | **운영 설정 필요(외부 콘솔) — 앱 코드는 2026-08-07 social-auth 배치에서 보강됨** |
| 근거 파일 | `app/login/page.tsx`, `app/components/SessionWatcher.tsx`, `lib/authAccount.ts`, `AUTH_SETUP.md` |
| 이번 배치에서 한 것 | `ensureAccountForCurrentUser()` 호출을 홈 화면 전용에서 앱 전체(SessionWatcher, SIGNED_IN/INITIAL_SESSION)로 옮겨 어느 페이지로 리다이렉트돼도 계정/프로필이 보장되도록 함. 소셜 버튼 로딩 상태(중복 클릭 방지)·OAuth 콜백 실패(`#error=...`) 감지 후 `/login?oauth_error=...`로 안내하는 처리 추가. 계정 연동(같은 이메일, 다른 provider) 정책은 `docs/08_Decision_Log.md` DEC-004로 명문화(자동 병합 안 함). |
| 완료 조건 | Supabase Provider(Google/Kakao/Apple), 각 제공자 콘솔 설정, Redirect URL과 Vercel 환경을 구성하고 신규·기존 계정 로그인과 실패 callback을 실제 provider로 검증함(코드는 준비됐지만 이 콘솔 설정 자체는 Claude가 대신 할 수 없음) |
| 관련 문서 | [REQUIREMENTS 5-1, 6-2](./REQUIREMENTS.md), [ROUTES `/login`](./ROUTES.md), `AUTH_SETUP.md` 3절 |

### P2-1b. 네이버 로그인 — Supabase 기본 미지원, 커스텀 Edge Function 필요

| 필드 | 내용 |
|---|---|
| 우선순위 | P2 |
| 현재 상태 | **미구현 — 별도 서버 코드 필요** |
| 근거 파일 | `AUTH_SETUP.md` 3-3절 |
| 내용 | 네이버는 Supabase가 기본 제공하는 OAuth provider 목록에 없다. `AUTH_SETUP.md`가 이미 권장하는 방식(네이버 access token을 Edge Function에서 받아 Supabase Admin API로 세션 발급)대로 Edge Function을 새로 작성해야 하는데, 네이버 개발자센터 Client ID/Secret 발급(외부 콘솔 작업)이 선행돼야 실제 왕복 검증이 가능하다. 지금은 버튼을 눌러도 "설정 안 됨" 안내만 뜨는 게 정상 동작. |
| 완료 조건 | 네이버 Client ID/Secret 발급 + Edge Function 작성/배포 + Redirect URL 등록 + 신규·기존 계정 로그인 실제 검증 |

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

### P2-13. service_role이 RLS Gap 17개 테이블에 대한 SQL GRANT가 없음(`contracts`/`notification_logs` 통합 테스트 자동화 불가)

| 필드 | 내용 |
|---|---|
| 우선순위 | P2 |
| 현재 상태 | **확인됨 — SQL 실행 필요, 이번 배치에서 실행하지 않음** |
| 근거 파일 | `tests/integration/sec009-batch-a1-rls.test.ts`, `tests/integration/setup.ts`(`describeAdminQueryError`) |
| 완료 조건 | `GRANT ALL ON TABLE contracts, notification_logs, ... TO service_role;`(대상 범위는 SEC-007 17개 테이블 전체로 할지 결정) 실행을 사용자 승인 후 진행하고, `contracts`/`notification_logs`의 자동화된 통합 테스트를 추가함 |
| 관련 문서 | [21_RLS_Gap_Analysis.md](./21_RLS_Gap_Analysis.md) |

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

### P2-16. (신규, 번호 충돌 주의) QA 통합 배치에서 발견한 항목 모음

| 필드 | 내용 |
|---|---|
| 우선순위 | P2 |
| 현재 상태 | **확인됨 — 이번 QA 배치(feature/qa-batch-nav-reservation-notifications)에서 발견, 일부는 같이 수정, 일부는 범위 밖으로 분리** |
| 관련 문서 | 이 브랜치는 PR #32(P0-6/P1-12/P2-15, `fix/holiday-refund-and-settings-wiring`)가 merge되기 전 `origin/main` 기준으로 만들어져 이 문서에 아직 P0-6/P1-12/P2-15 항목이 없습니다 — **PR #32와 이 브랜치가 모두 merge된 뒤 번호가 겹치지 않는지 반드시 확인하세요.** |

⚠️ **git/실제 라이브 DB 불일치**: PR #32는 아직 merge되지 않았지만 그 SQL(수강권 복구,
`admin_action_logs` FK 2개, `reserve_class()`의 당일예약/일일한도/대기한도/오픈시각)은 이미
실제 Supabase에 실행되어 라이브 상태입니다. `reservation_functions.sql`(git)은 여전히 옛
버전입니다. 이번 QA 배치의 SQL(`fix_class_booking_deadline_override_draft_proposed.sql`,
`fix_reservation_cancel_grace_period_draft_proposed.sql`)은 **라이브 DB 기준**(PR #32 적용
후 버전)으로 작성했습니다 — git의 `reservation_functions.sql`만 보고 베이스라인을 판단하면
안 됩니다. PR #32가 merge되면 `reservation_functions.sql` 자체도 최신화가 필요합니다(기존
P0-2/P0-3와 동일한 종류의 "migration ledger" 문제).

- **`cancel_deadline_min`이 `booking_deadline_min`과 동일한 이유로 사실상 무효**: `calc_deadline()`은
  `center_settings`가 있으면(사실상 항상) 무조건 그 값을 쓰고, `classes.cancel_deadline_min`은
  그 설정 행 자체가 없는 예외 상황에서만 폴백으로 쓰인다. `cancel_deadline_min`은 이미
  관리자 UI(`app/manager/classes/page.tsx` "예약취소 가능 시간")에 연결돼 있어 실제로 값을
  저장했을 수도 있어, `booking_deadline_min`과 달리 이번 배치에서 함께 고치지 않았다(0을
  "미지정"으로 되돌리는 데이터 마이그레이션이 더 신중한 검토가 필요 — CLASS-001 SQL 헤더
  주석 참고). **후속 조치 필요**: 실제 저장된 0이 아닌 값이 있는지 먼저 확인한 뒤 같은 패턴으로
  수정.
- **알림 카테고리가 8개가 아니라 4개뿐이고 서버가 이 설정을 전혀 읽지 않음(2026-08-07 P2
  배치에서 부분 해결)**: `app/settings/notifications/page.tsx`의 알림 설정은 `localStorage`에만
  저장되고(`reservation`/`waitlist`/`reminder`/`marketing` 4종), 모든 서버 트리거
  (`trg_notify_reservation_insert/_update`, `send_inquiry_message` 등)는 이 설정과 무관하게
  항상 알림 행을 만든다 — 이건 그대로 유지한다(알림함은 항상 기록이 남아야 함, 감사 로그
  성격). 다만 실시간 팝업(`NotificationToaster`)만큼은 `lib/notifications.ts`의
  `notiPrefKeyForKind()`로 이 설정을 실제로 읽어 팝업 표시 여부를 거르도록 연결했다(SQL
  변경 없음, 저위험). **여전히 남은 것**: 서버측 발송 자체를 막는 것(수신거부를 트리거
  SQL에 반영), "공지/결제" 등 카테고리 확장, "혜택·이벤트"(마케팅) 알림을 실제로 만드는
  기능 자체 — 전부 DB 변경 및 제품 결정이 필요한 별도 작업.
- **`notification_rules`/`messages`(SMS/LMS)/`notification_logs`는 스키마만 있고 완전 미구현**:
  `app/settings/notifications/page.tsx`의 "실제 발송 연동은 준비 중이에요" 문구는 정확하다 —
  In-app DB 알림 외에는 push(FCM/APNs)/SMS/카카오 알림톡/이메일 전부 백엔드 자체가 없다.
  문구를 더 명확하게(채널별로) 다듬는 것을 이번 배치에서 진행함(E-3).
- **문의 답변 알림이 스레드로 딥링크되지 않음**: `notifications.data.thread_id`가 저장되지만
  `app/notifications/page.tsx`/`app/manager/notifications/page.tsx`의 클릭 핸들러가 `link`만
  보고 이동해 목록 화면까지만 가고 특정 스레드는 자동 선택되지 않는다 — 이번 배치에서 함께 수정.
- **`app/mypage/history/page.tsx`(전체 예약 내역)가 어디서도 링크되지 않는 고아 라우트**:
  `fetchFullHistory()`(최대 500건, 상태별 필터)까지 구현돼 있지만 진입 경로가 없다 — 별도
  판단 필요(내 예약 탭에 링크를 추가할지, 페이지 자체를 정리할지).
- **(E-6) 운영설정의 "문의 게시판 사용"/"락커 기능 사용"/"회원앱 라운지 사용" 토글 제거**:
  `use_inquiry_board`/`use_locker`/`use_lounge` 세 컬럼 모두 `schema.sql`/`lib/settings.ts`/
  이 UI 외에는 어디서도 읽지 않는 죽은 설정임을 grep으로 확인(관리자가 켜고 꺼도 실제 효과
  없음) — `app/manager/settings/page.tsx`의 토글 UI에서만 제거했다. DB 컬럼은 이번에 지우지
  않았다(향후 락커/라운지/문의게시판 기능이 실제로 만들어지면 그때 이 컬럼을 다시 쓸 수도
  있어 임의로 삭제하지 않음 — 실제 컬럼 삭제는 별도 migration 이슈로 분리해서 판단 필요).

### P2-17. (신규) 실브라우저 QA 재검증에서 발견한 항목

- **`calc_deadline()`의 `'open'` kind 미처리(P1급, 수정 SQL 준비됨)**: `reserve_class()`가
  "예약 오픈 시점" 체크를 `calc_deadline(...,'open')`로 호출하지만, 함수 본문은 `'book'`/그 외
  (취소) 두 갈래로만 분기해 관리자가 저장한 `group_open_days_before/time`·
  `private_open_days_before/time`이 무시되고 취소 마감 설정이 대신 쓰이고 있었다.
  `fix_calc_deadline_open_kind_draft_proposed.sql`로 수정 준비됨(승인 대기). 이전 배치 문서의
  "C-2 정상 배선" 결론은 이 항목에 한해 **틀렸음** — 함수 실제 정의를 재확인하지 않은 오판.
- **(해결됨, 2026-08-03 Track 4) `show_group_reserved_count`**: `lib/reservations.ts`가
  `center_settings`를 함께 조회하도록 확장해 `app/reservation/page.tsx`에서 실제로 인원수
  표시 여부를 제어하도록 구현 완료.
- **(해결됨, 2026-08-03 Track 4) `auto_unpaid_input`**: `app/manager/sales/page.tsx` 결제 등록
  시트에서 상품가 - 입력된 결제수단 합계를 자동으로 미수금에 채우도록 구현 완료
  (`lib/sales.ts`의 `computeAutoUnpaid`).
- **`show_group_waitlist_count` 여전히 미구현(P2, 표시 대상 자체가 없음)**: 회원 앱 어디에도
  "대기 인원수"를 보여주는 UI가 없어(내 대기 순번 표시만 있음) 이 설정을 연결할 대상이 없다
  — 대기 인원수 표시 UI 자체를 새로 만들어야 하는 별도 소규모 기능. 전체 동작표는
  `docs/OPERATIONAL_SETTINGS_AUDIT.md` 참고.
- **`private_slot_unit`/`show_point_history`는 제품 결정 필요**: `docs/08_Decision_Log.md`
  DEC-002(슬롯 시스템) 참고. `show_point_history`는 포인트 내역 페이지 자체가 없어 페이지
  신설이 선행돼야 함. `private_max_concurrent_*`는 2026-08-06 P3 배치에서 해결됨(아래 항목).
  DEC-003(class_allowed_products UI 부재)도 같은 배치에서 Resolved로 닫힘 — UI는 이미
  구현돼 있었고(이전 배치), 이번엔 검색 UI·서버 강제(`reserve_with_membership`)·RLS 강화만
  추가함.
- **`same_day_change_*`/`autocancel_*`/`waitlist_auto_*`는 스케줄러 인프라 부재로 UI에
  "준비 중" 배지 추가 + 입력 비활성화 처리(2026-08-03)** — 정상 기능처럼 보이지 않도록 함,
  값 자체는 보존(추후 스케줄러 도입 시 그대로 사용 가능).
- **`NotificationToaster`처럼 알림 관련 UI가 여러 곳에 독립 구현되며 로직이 갈라지는 패턴**:
  이번에 회원/매니저 알림 목록과 실시간 토스트가 각자 딥링크 판단을 구현하다 토스트만 누락된
  사례가 발생했다. `lib/notifications.ts`의 `notificationHref()`로 통합했으나, 향후 새 알림
  표시 지점을 추가할 때도 이 함수를 재사용하도록 유의할 것.
- **AUTH-001(신규 이슈, #40)**: 회원가입 화면에 휴대폰 번호 입력란은 있지만 실제 인증(OTP)
  절차가 없음. SMS 발송 백엔드 자체가 없어(E-3 감사와 동일 결론) 제품 정책 확정 전에는
  구현하지 않음.
- **`staff_salaries` 유니크 제약 충돌로 SEC-009 통합테스트가 간헐적으로 실패(신규 발견,
  TEST-002/#24와 같은 계열의 "공유 dev DB에 정리 안 된 테스트 픽스처" 문제)**: PR #39 CI에서
  `sec009-batch-a1-rls.test.ts`가 "duplicate key value violates unique constraint
  staff_salaries_center_id_account_id_key"로 실패하는 것을 관측함 — 이전 실행이 남긴
  (centerA, managerA 계정) 조합의 `staff_salaries` 행이 정리되지 않아 재실행 시 같은 키로
  다시 insert하려다 충돌. 이번 배치의 어떤 코드/SQL과도 무관(다른 테이블, 다른 테스트 파일).
  TEST-002(#24)와 같은 근본 원인 계열이므로 그 이슈 해결 시 함께 검토 권장 — 이번 배치에서는
  별도 정리 SQL을 만들지 않음(범위 밖).
- **(2026-08-08 재확인) `tests/e2e/admin/class-allowed-products.spec.ts`도 TEST-002(#24)
  오염의 영향을 받음**: P4(매출 대시보드) CI 2회차 연속 Green 확인 중, 이 파일과 전혀 무관한
  커밋(P4는 sales.ts/manager 홈/SQL만 변경)에서 이 spec만 실패 — 실패 로그를 보면 검색 결과
  목록에 "E2E 테스트 수강권"이 수십 건 중복으로 쌓여 있어(`toHaveCount`/`not toContainText`
  단언이 그 개수·존재 여부를 검사) 정상적인 코드 동작과 무관하게 실패했다. 바로 다음(직전) CI
  실행에서는 같은 코드로 이 spec이 정상 통과했었다 — 실행 시점마다 쌓인 오염량에 따라 간헐적으로
  Red/Green이 갈리는 것으로 보인다. 범위 밖(TEST-002/#24 해결 시 함께 검토), 재실행으로 우회.
- **TEST-002(#24)의 알려진 오염이 다른 파일에도 영향을 준다는 것을 재확인**: `acl-003-permission-read.test.ts`가
  남기는 "MANAGER_B가 centerA의 활성 스태프가 됨" 오염 상태 때문에, 이번 배치가 새로 추가한
  `tests/integration/inquiry-access-isolation.test.ts`의 "다른 센터 매니저는 못 본다" 케이스와
  기존 `admin-assignment-security.test.ts`의 "다른 센터 관리자는 배치 못 함" 케이스가 같은 CI
  실행에서 함께 실패하는 것을 관측함(둘 다 설계·코드 문제 아님, RLS/RPC는 "활성 소속 여부"를
  정확히 설계대로 검사 중 — #24 해결 전까지는 테스트 실행 순서에 따라 이 두 케이스가 간헐적으로
  RED일 수 있음).

### P2-18. (신규, 2026-08-08, 2026-08-10 상태 정정) P4 매출/통계 대시보드 — SQL 적용 완료

| 필드 | 내용 |
|---|---|
| 우선순위 | 해결됨(과거 P2) |
| 현재 상태 | **적용 완료.** 아래 네 SQL(payment_provider → dashboard_summary → daily_bug fix → service_role payments grant) 전부 적용됨 — `dashboard-summary.test.ts` 7/7이 P2-20 최종 검증(2026-08-09, 3연속 Integration Green)에도 포함돼 계속 통과 확인됨. 이 상태 필드가 "SQL 적용 대기"로 오래 남아 있던 것은 문서 갱신 누락이었고(PR #44 리뷰 중 발견), 실제 DB 상태와는 무관 — 2026-08-10 정정. |
| 근거 파일 | `fix_payments_payment_provider_draft_proposed.sql`, `add_manager_dashboard_summary_draft_proposed.sql`, `fix_manager_dashboard_summary_daily_bug_draft_proposed.sql`, `fix_service_role_missing_grants_payments_draft_proposed.sql`, `lib/sales.ts`(`fetchDashboardSummary`), `app/manager/page.tsx`, `tests/integration/dashboard-summary.test.ts` |
| 완료 조건 | ~~SQL 4개 순서대로 적용~~ 완료 |

- **2026-08-08 CI 1차 재실행에서 SQL 버그 발견**: `payment_provider`/`dashboard_summary`
  두 SQL 적용 직후 CI를 재실행하니 `dashboard-summary.test.ts` 6건이 전부
  `"column d.date does not exist"`로 실패 — `manager_dashboard_summary()`의 `daily`
  필드 서브쿼리에서 별칭 실수(`d.date` → `days.date`여야 함). 세 번째 SQL
  `fix_manager_dashboard_summary_daily_bug_draft_proposed.sql`로 수정.
- **2026-08-08 CI 2차 재실행에서 DB 인프라 문제 발견**: daily 버그 수정 SQL 적용 후 CI를
  또 재실행하니 이번엔 `"permission denied for table payments"`로 전부 실패 — service_role이
  `payments` 테이블에 대한 SQL GRANT 자체가 없었다(기존 결제 경로가 전부 security definer
  RPC라 지금까지 드러나지 않던 gap, `fix_service_role_missing_grants_for_e2e_admin_draft_proposed.sql`
  과 같은 계열). 네 번째 SQL `fix_service_role_missing_grants_payments_draft_proposed.sql`로 해결.

- 매니저 홈(`/manager`)에 오늘/7일/30일 매출 요약 카드와 일별 막대그래프를 추가했다.
  `manager_dashboard_summary()` RPC가 DB에서 직접 SUM/COUNT로 집계해(1000행 응답 제한 위험
  없음) Mock 결제(`payment_provider='mock'`)를 항상 제외한다.
- **알려진 한계**: 수강권/상품 매출 구분은 `payments.membership_id → memberships.product_id
  → products.product_kind` 조인으로 계산한다(`revenue_category`는 `registerPayment()`가
  항상 `'membership'`만 저장해 신뢰 불가 — 코드 감사로 확인). 한 결제에 "추가 상품"
  (`extraProducts`)이 함께 발급된 경우 그 추가 상품 매출은 결제 건의 대표 `membership_id`
  하나로만 잡혀 별도 집계되지 않는다 — 정확한 상품별 세부 분해가 필요해지면 스키마 변경
  (결제-상품 다대다 연결 테이블 등)이 별도로 필요하다.
- SQL 미적용 상태에서는 대시보드 카드가 에러 문구를 보여주고(RPC 없음), `payment_provider`
  컬럼이 없어 `confirm_test_payment()`도 기존 정의 그대로 동작(회귀 없음 — `create or replace`
  전이라 기존 mock 결제 발급 자체는 계속 정상 동작).

### P2-19. (신규, 2026-08-09) class-allowed-products.spec.ts 간헐 실패의 실제 원인 — 공유 테스트 센터 오염, 정리 SQL 적용 대기

| 필드 | 내용 |
|---|---|
| 우선순위 | P2 (오염 정리 자체는 완료·검증됨 — 아래 P2-20의 별개 버그가 새 블로커) |
| 현재 상태 | **오염 정리 완료(v4 적용+검증됨). class-allowed-products.spec.ts는 여전히 실패하지만 원인이 오염이 아님을 확인 — P2-20 참고** |
| 근거 파일 | `cleanup_shared_test_center_pollution_draft_proposed.sql`(v4, 적용 완료), `tests/integration/setup.ts`(`createTestMembership`), `tests/e2e/fixtures/testData.ts`(`createTestMembershipAdmin`/`createTestGoodsMembershipAdmin`), `tests/integration/class-allowed-products-enforcement.test.ts`, `tests/integration/usable-memberships-pass-kind.test.ts`, `tests/e2e/admin/attendance.spec.ts` |
| 완료 조건 | (오염 정리 자체는 완료) — class-allowed-products.spec.ts의 전체 Green은 P2-20 해결에 달려 있음 |

- **v4 SQL 적용 완료 및 검증(2026-08-09)**: 사용자가 Supabase SQL Editor에서 v4를 에러 없이
  실행함. 적용 후 읽기 전용 진단(diag_only 모드)으로 6개 정리 대상을 직접 재확인 —
  admin_action_logs(v4 자체의 트랜잭션 내 재확인 가드로 확인, service_role의 PostgREST
  GRANT가 없어 독립 재조회는 못 함)/orphan profiles/"통합테스트 수강권"/
  "통합테스트 수강권(P3)"/"P0-6 테스트 무제한권"/"USABLE-PASS-KIND 테스트 대여품" 상품
  전부 0건. 임시 진단 스캐폴딩(`tests/integration/_diag_pollution.test.ts`,
  `.github/workflows/test.yml`의 `diag`/`diag_only`)은 진단 완료 후 삭제해
  `test.yml`이 이 조사 이전 상태와 완전히 동일함을 `git diff`로 확인함.

- **v1→v4 반복(2026-08-09)**: v1(admin_action_logs FK 위반, 놓친 FK 전수 재감사로 v2) →
  v2(같은 FK 오류 재발 — admin_action_logs DELETE 자체는 성공했지만, get-or-create로
  재사용되는 membership에 admin-assignment-security.test.ts의 다른 세션이 admin_action_logs를
  새로 insert해 같은 트랜잭션의 나중 DELETE가 그 새 참조에 걸림 → LOCK TABLE로 막는 v3) →
  v3(FK 오류는 해결됐지만 row-count guard가 안전하게 중단 — 진단 시점 2525건이던
  "통합테스트 수강권" 모집단이 실행 시점엔 168건으로 줄어 있었고 전부 userA/managerA가
  아닌 제3의 TEST_* profile_id 소속이었음, utf8 byte 비교로 유니코드 정규화 문제는 아님을
  확인) → v4(profile_id 제한 자체를 제거 — 이 product_name 문자열은 처음부터 어느
  profile_id에도 안 묶여도 구조적으로 테스트 전용인 값이었고, 시점마다 여러 TEST_* 계정
  사이를 오가는 모집단에 특정 2개 profile_id로만 좁히는 게 오히려 정리를 막았음). 상세
  경위는 SQL 파일 헤더 주석 참고.

### P2-21. (2026-08-10, 진행 중 — 재현 실패했지만 종결 아님) PR #44 수동 QA "신규 수업은 사용 가능한 수강권이 없다고 뜸"

| 필드 | 내용 |
|---|---|
| 우선순위 | P1 (사용자 지시로 재오픈 — 자동화 공백을 메우기 전엔 종결 금지) |
| 현재 상태 | **TEST_MANAGER_A/TEST_USER_A/centerA 기존 fixture + 실제 관리자 UI 등록 경로로는 재현 실패(변동 없음). 사용자 지시에 따라 구매 직후 즉시 사용 가능 여부(TEST4)와 goods 배제(TEST5)까지 실제 브라우저로 구현/검증 완료 — 3회 연속 통과. 그러나 무관한 사전 존재 이슈(`attendance-policy.test.ts`의 주간 대기예약 한도 초과, 아래 참고) 때문에 "전체 CI 2회 연속 Green" 요건은 아직 미충족 — PR #44는 여전히 merge 안 됨** |
| 근거 파일 | `tests/e2e/admin/new-class-creation.spec.ts`(TEST1/TEST2/TEST4/TEST5/TEST6) |
| 완료 조건 | (a) `attendance-policy.test.ts` 블로커에 대한 사용자 결정(데이터 정리 승인 또는 현재 증거로 충분하다고 판단) + 전체 CI 2회 연속 Green, 또는 (b) 사용자가 원래 수동 QA에서 다른 계정/센터/상품을 썼다는 추가 정보를 주면 재조사 |

- **TEST4/TEST5 결과(2026-08-10 추가, 실제 브라우저 3회 연속 통과)**: 신규 수업 생성(A: 모든
  수강권 허용, B: 특정 pass만 허용) → 회원이 "사용 가능한 수강권 없음" 확인 → 실제
  "수강권 구매하기" → 센터 구매 시트 → `/checkout` mock 결제 완료 → "지금 바로 예약
  이어가기" 클릭(전체 페이지 재로드, `<a href>`) → 같은 예약창 재오픈 → 방금 구매한 pass가
  즉시 `.pass-pick-list`에 표시 → 예약 성공까지 전부 실측 확인. goods(`E2E 테스트 대여품
  상품`)는 구매 가능 목록/적용 가능 수강권 어디에도 노출되지 않음(`fetchPurchasableProductsByClass`가
  `product_kind='pass'`로 구조적으로 필터링).
- **구매 직후 상태 갱신 경로**: 별도의 client-side 캐시 갱신 로직이 전혀 없다 — "지금 바로
  예약 이어가기" 링크와 1.8초 후 자동 fallback 둘 다 `window.location.href` 풀 페이지
  이동이라, 예약창이 완전히 새로 마운트되며 `usable_memberships_for_classes`를 처음부터
  다시 호출한다. 구조적으로 stale-cache가 발생할 여지가 없음(실측 3/3 확인, race 아님).
- **재현 시도 절차(전부 CI 실측, 추측 없음)**: (1) read-only 진단으로
  `membership_schedule_rules`가 centerA 전체 0건임을 확인(과거 이 정확한 증상을 냈던
  "모든 수강권 허용으로 저장해도 자동으로 schedule_rules가 추가되던" 앱 버그의 잔여
  데이터 가설을 반박 — 그 버그는 이미 고쳐졌고 남은 데이터도 없음), (2) admin client로
  직접 insert한 새 class가 기존 class와 RPC 결과가 완전히 동일함을 확인, (3) 실제
  Playwright 브라우저로 관리자 UI를 통해 새 class를 등록(모든 수강권 허용/특정 pass 1개
  허용 둘 다) → class_allowed_products/RPC/회원 화면(`.pass-pick-list`)/실제 예약 성공까지
  전부 정상 동작 확인. (4) 이번에 TEST4/TEST5로 구매 → 즉시 사용까지 실제 결제 흐름
  전체를 추가로 재현 시도했으나 역시 재현 실패.
- **조사 중 실제로 찾은 것은 앱 버그가 아니라 테스트 자체의 결함 3건**(전부 코드 변경 없이
  수정, 상세 경위는 `tests/e2e/admin/new-class-creation.spec.ts` 파일 상단 주석 참고):
  Node 쪽에서 인증 안 된 세션으로 `class_allowed_products`를 조회해 RLS에 항상 막힌 것,
  테스트가 임의로 고른 90/91일 뒤 날짜가 "예약 오픈 기한"(`groupOpenDaysBefore`, 기본
  60일)을 초과해 `reserve_with_membership()`이 설계대로 정확히 거부한 것, `.class-row`
  재진입 클릭 전에 달력 날짜 칸을 안 눌러 그 날짜 목록 자체가 안 보였던 것.
- **부산물**: `fix_calc_deadline_open_kind_draft_proposed.sql`(open kind 분기)이 실제
  적용돼 있음을 `operational-settings-wiring.test.ts` 통과로 재확인.
  `class_allowed_products`에 대한 service_role GRANT가 여전히 없음을 재확인(기존
  P2-13/RES-002 계열과 같은 gap, 이번엔 새 조치 안 함).
- **남은 가능성(재현 실패했다고 "버그가 없다"고 100% 단정하지는 않음)**: 사용자의 원래
  수동 QA가 이 fixture와 다른 계정/센터/상품을 썼을 수 있고, 그 경우 그 계정/상품에만
  존재하는 stale `membership_schedule_rules`나 다른 데이터 특이사항이 원인일 수 있다 —
  이번 조사로는 배제하지 못함. 추가 재현 정보가 오면 그때 계속 조사할 것.

### P1-15. (2026-08-10, 최종 완료) PR #44 수동 QA 버그 — 실제 dev 계정에서는 100% 재현됨(TEST fixture는 정상)

| 필드 | 내용 |
|---|---|
| 우선순위 | P0(실제 결제/예약 핵심 흐름에 영향, 실제 계정에서 100% 재현) |
| 현재 상태 | **완료. root cause 확정, 코드 수정 완료, regression test 전부 통과, 전체 CI 2연속 Green(run `31411383724`/`31413532650`). 사용자가 `cleanup_p1_15_stale_schedule_rules_draft_proposed.sql`을 Supabase SQL Editor에서 적용(`remaining_target_rules=0` 확인). 사후 read-only 재검증(run `31421494819`, `diag_p1_15_verify` job)에서 "수강권" 상품의 `membership_schedule_rules`가 0건임과, 실제 회원(memberB)의 "수강권" memberships 3건 전부가 "테스트" class에서 `usable예측=true`로 재계산됨을 실측 확인. 회귀 확인 CI도 재검증 시점에 2연속 Green(run `31419033306`/`31421494819`, 둘 다 first-attempt) 재확인.** |
| 근거 파일 | `app/manager/classes/page.tsx`, `lib/passes.ts`(`fetchRulesForProducts`/`matchesAnyScheduleRule`/`findScheduleExcludedProducts`), `tests/unit/passes.scheduleRuleWarning.test.ts`, `tests/e2e/admin/membership-schedule-rules.spec.ts`, `fix_service_role_missing_grants_accounts_draft_proposed.sql`+`_write_draft_proposed.sql`(둘 다 적용 완료), `cleanup_p1_15_stale_schedule_rules_draft_proposed.sql`(적용 완료, `remaining_target_rules=0` 확인) |
| 완료 조건 | ~~전체 CI 2연속 Green~~ 완료. ~~schedule_rules cleanup SQL 적용~~ 완료. ~~사후 read-only 재검증~~ 완료. |

- **코드 분석으로 찾은 유력 단서 → 실제 계정 데이터로 확정**: `usable_memberships_for_classes()`(`fix_usable_memberships_product_kind.sql`)는 파라미터로 받는 `p_profile_id`가 아니라 **호출 세션의 계정**(`my_account_id()`, `auth.uid()` 기반)으로 memberships를 필터링한다 — 이건 의도된 설계(가족 프로필 공유)이고 실제 계정도 문제없이 이 조건을 통과했다. 실제 탈락 원인은 `membership_schedule_rules` — 실제 "수강권" 상품에 화/수 특정 시간·"수업"이라는 제목으로 제한하는 규칙 2건이 걸려 있었고, 신규 "테스트" 수업(월요일)은 이 조건과 전혀 안 맞아 보유 pass·신규 구매 pass 전부 탈락했다. class_allowed_products("모든 수강권 허용")는 상품 제한만 해제할 뿐 이 조건은 별개로 계속 적용된다 — RPC는 정확히 설계대로 동작.
- **UX 수정**: 수업 등록/수정 화면의 "예약 가능 수강권" 섹션에 (a) "모든 수강권 허용은 상품 제한만 해제, 수강권 자체의 요일/시간 조건은 별개로 계속 적용" 고정 설명 + (b) 현재 날짜/시간/제목 기준 실제 배제되는 수강권이 있으면 `.schedule-rule-warning` 경고 표시(어느 조건 때문인지까지 표시). "특정 수강권 지정" 모드도 동일 계산 로직으로 함께 커버.
- **schedule_rules 2건의 용도/생성 경로 확정(read-only 진단, CI run `31413532650`)**: 이 두 규칙이 가리키는 제목("수업")의 class가 실제로 2건 존재 — 화요일 16:00(class `00494e21...`)/수요일 15:00(class `93a6c842...`). 각 규칙의 `created_at`이 대응하는 class의 `created_at`과 **초 단위로 거의 동시**(0.5~0.6초 차이)에 생성됐다 — 이 저장소에 이미 문서화된, 지금은 고쳐진 옛 버그(class_allowed_products 저장 부수효과로 membership_schedule_rules 자동 생성, `class-allowed-products.spec.ts` beforeAll 주석 참고)와 정확히 같은 신호. 두 class 모두 진단 시점(2026-08-10) 기준 이미 지난 날짜이고 반복되는 일정이 아니다 — 관리자가 `/manager/membership-rules`에서 의도적으로 설정했다기보다 그때 class를 만든 부수효과로 자동 생성됐을 가능성이 매우 높다. `cleanup_p1_15_stale_schedule_rules_draft_proposed.sql` + rollback 작성 완료(id 2건 정확히 지정, FK 없음 확인) — **Supabase에는 실행하지 않음, 사용자 결정 필요**.
- **실제 계정 진단 중 발견한 무관한 문제들(이 버그 자체와는 무관, 인프라/타 이슈)**: groupOpenDaysBefore 값 복구(완료), `accounts` service_role GRANT 추가(SELECT + INSERT/UPDATE/DELETE, 둘 다 사용자 적용 완료). P1-16(무관한 사전 존재 버그, 해결 완료) 참고.
- **cleanup SQL 적용 완료(2026-08-10) + 사후 read-only 재검증**: 사용자가 Supabase SQL Editor에서 A(preview)/B(BEGIN...COMMIT, guard 포함 delete)/C(post-verification) 순서로 실행, `remaining_target_rules=0` 확인 보고. 별도 임시 read-only 진단(`_diag_p1_15_postcleanup_verify.test.ts`, workflow_dispatch 전용, 검증 완료 후 삭제)으로 (1) `membership_schedule_rules` 독립 재조회 결과 0건, (2) 실제 회원 memberB의 "수강권" memberships 3건 전부 `usable예측=true`(status/remaining/expires/classAllowed/scheduleRule 전 조건 true), (3) "테스트" class의 `class_allowed_products`는 여전히 0건("모든 수강권 허용" 유지)임을 확인. "새로 구매한 수강권"·"특정 수강권 지정" 케이스는 실제 QA 계정에 새 데이터를 쓰는 대신, 격리된 E2E 회귀 테스트(`membership-schedule-rules.spec.ts`의 test E/C+D+F)로 그 일반 메커니즘이 여전히 정확히 동작함을 검증(같은 상품이면 새로 발급된 membership도 동일 제한 적용, class_allowed_products로 허용해도 schedule rule 불일치면 여전히 차단 + 관리자 경고 노출).
- PR #44는 여전히 MERGE BLOCKED 상태(사용자 지시로 계속 유지, main merge는 별도 명시적 요청 전까지 하지 않음) — P1-15는 이 항목 자체로는 완료, 최종 merge 가능 여부는 사용자의 수동 QA 재확인 및 별도 merge 지시에 달려 있음.

### P1-16. (2026-08-10, 해결 완료) `accounts` 테이블 service_role INSERT/UPDATE/DELETE GRANT 누락 — 소셜 로그인 부트스트랩 테스트 반복 실패

| 필드 | 내용 |
|---|---|
| 우선순위 | 해결됨(과거 P1) |
| 현재 상태 | **완료. 사용자가 `fix_service_role_missing_grants_accounts_write_draft_proposed.sql` 적용 → `auth-account-bootstrap.test.ts` 2회 연속 통과(run `31411383724` first-attempt, `31413532650`) 확인. "permission denied for table accounts" 완전히 사라짐.** |
| 근거 파일 | `tests/integration/auth-account-bootstrap.test.ts`, `fix_service_role_missing_grants_accounts_write_draft_proposed.sql`(적용 완료), `rollback_fix_service_role_missing_grants_accounts_write_draft_proposed.sql` |
| 완료 조건 | ~~사용자가 SQL 적용~~ 완료. ~~해당 테스트 재검증~~ 완료(2연속 통과). |

- **최초 가설(틀림, 정정함)**: 처음엔 `lib/authAccount.ts`의 `ensureAccountForCurrentUser()`가
  마지막 `profiles` insert의 error를 확인하지 않는 게 원인이라고 추정했다. 이 가설을
  **추측으로 남기지 않고 임시 진단 로그를 추가해 실측으로 검증**했는데(CI run `31408951718`),
  그 로그가 **한 번도 찍히지 않았다** — 즉 그 코드 경로 자체에 진입하지 않았다는 뜻이라
  가설이 틀렸음을 확인하고 진단 로그는 즉시 원복(`lib/authAccount.ts`는 최종적으로 변경 없음).
- **진짜 원인(실측 확정)**: 같은 run의 로그에 `tests/integration/auth-account-bootstrap.test.ts`의
  `beforeAll`이 남긴 경고가 그대로 찍혀 있었다 — `"throwaway 계정 accounts 정리 실패(무시하고
  계속): permission denied for table accounts"`. 이 `beforeAll`은 이전 실행이 남긴 throwaway
  테스트 계정을 admin(service_role)으로 정리하는데, `accounts` 테이블에 service_role
  INSERT/UPDATE/DELETE GRANT가 없어(SELECT만 최근에 추가됨, P1-15 참고) 이 delete가 항상
  실패한다(`payments`/`admin_action_logs`/`profiles`/`class_allowed_products`와 동일 계열의
  이미 여러 번 나온 GRANT 누락 패턴). delete 실패로 낡은 accounts 행이 남고, 그 행은 이미
  profiles가 지워진 상태라, 다음 `ensureAccountForCurrentUser()` 호출이 이 낡은 계정을
  "이미 있음"으로 판정해 조기 반환 — profiles가 끝내 하나도 안 만들어져 테스트가 실패했다.
  이 테스트 파일 자신의 주석에 남아있던 "원인 불명" 과거 실패도 같은 원인으로 설명된다.
- **분류**: DB/RLS/GRANT 문제(앱 코드 버그 아님, `lib/authAccount.ts`는 정상). 실제 소셜
  로그인 사용자는 authenticated 세션(RLS)으로 accounts를 직접 관리하므로 이 GRANT 누락의
  영향을 받지 않는다 — 순수하게 테스트 cleanup(admin/service_role 경로) 전용 문제.
- **검증 완료**: SQL 적용 후 `auth-account-bootstrap.test.ts` 2회 연속 통과, throwaway 계정 cleanup이 정상적으로 성공함을 확인(더 이상 accounts/profiles 잔여 데이터가 누적되지 않음).

### P1-17. (2026-08-11, 완료) 신규 예약 정책: 관리자가 직접 지정한 수강권은 membership_schedule_rules보다 우선

| 필드 | 내용 |
|---|---|
| 우선순위 | P1(사용자 요청 정책 변경, PR #44 안정화 Batch의 Phase 1) |
| 현재 상태 | **완료. 코드/SQL 변경 완료, 사용자가 SQL 적용 완료. 전체 CI 2연속 Green 확인(run `31459078105`/`31460392240`, 둘 다 first-attempt·재시도 없음). 검증 과정에서 신규 통합 테스트 자체의 세션/RPC 선택 결함 2건을 발견해 수정(A/B/C가 공유 테스트센터의 다른 membership으로 우연히 통과/실패하던 문제, month-data 테스트의 세션 전환 누락 — 둘 다 test bug, 앱/SQL 무관).** |
| 근거 파일 | `fix_membership_schedule_rule_override_draft_proposed.sql`(적용 완료)+rollback, `app/manager/classes/page.tsx`, `tests/integration/schedule-rule-override.test.ts`(신규, A~J), `tests/e2e/admin/membership-schedule-rules.spec.ts`(D+F+K/J 갱신) |
| 완료 조건 | ~~전체 CI 2연속 Green~~ 완료. |

- **정책**: P1-15가 확정한 "class_allowed_products 허용 AND membership_schedule_rules 충족"
  정책에서, 관리자가 그 class에 특정 product를 class_allowed_products로 **명시적으로** 지정한
  경우에 한해 membership_schedule_rules를 무시하도록 확장했다. "모든 수강권 허용"(0건)이면
  기존 정책 그대로 유지된다. override는 schedule_rules만 우회하며 status/remaining_count/
  expires_at/product_kind='pass'/center 소속 등 다른 정상 조건은 그대로 적용된다.
- **적용 함수**: `usable_memberships`/`usable_memberships_for_classes`(표시), `reserve_class`
  (자동매칭), `reserve_with_membership`(회원이 직접 pass 선택 — 실제 예약 확정 경로).
  `admin_assign_reservation`은 라이브 코드에 이미 "수강권 종류/예약조건 제한은 두 방식 모두
  무시" 주석과 함께 class_allowed_products/membership_schedule_rules를 전혀 확인하지 않는
  것으로 확인돼(2026-08-11 `pg_get_functiondef` 직접 조회) 변경하지 않았다.
- **함께 발견/수정한 별도 갭**: `reserve_with_membership`(실제 회원 예약 확정 RPC)은 지금까지
  `membership_schedule_rules`를 전혀 확인하지 않고 있었다(`class_allowed_products`만 나중에
  추가되고 schedule_rules는 누락된 채로 남아 있었음 — 라이브 코드 자체 주석으로 확인). 화면
  목록(`usable_memberships_for_classes`)에서는 걸러졌지만 실제 RPC는 막지 않아 "목록≠실제
  예약 정책" 불일치가 있었다(`lib/reservations.ts:364-366` 기존 주석이 요구하는 불변식을
  위반). 이번에 이 조건을 새로 추가하면서 처음부터 override까지 포함해 넣었다.
- **소스 오브 트루스**: git의 `reservation_functions.sql`은 PR #32의 라이브 변경분(당일예약/
  일일한도/오픈시각 등)이 반영되지 않은 옛 버전이라(P2-16에 이미 문서화) 기준으로 삼지
  않고, 사용자가 Supabase SQL Editor에서 `pg_get_functiondef()`로 직접 추출한 2026-08-11
  라이브 본문을 기준으로 함수 전체를 재작성했다. 원본 가드(예약마감/오픈시각/당일예약/
  일일한도/휴무일/프라이빗 동시진행/대기예약 주간한도 등)는 전혀 손대지 않았다(정확한
  문자열 카운트 스크립트로 대조 확인).
- **별도 기존 문제(이번에 고치지 않음)**: `usable_memberships*`는 `class_title`을 정확히
  일치(`=`)로, `reserve_class`/`reserve_with_membership`은 부분 일치(`LIKE '%...%'`)로 비교 —
  서로 다른 매칭 규칙이 이미 라이브에 공존하고 있었다(이번 변경으로 만든 문제 아님, 범위 밖).
- **UX**: 수업 등록/수정 화면의 schedule-rule 경고를 모드별로 분리 — "모든 수강권 허용"일
  때는 기존 `.schedule-rule-warning`(danger) 그대로, "특정 수강권 지정" 모드에서 override
  대상이 있으면 새 `.schedule-rule-override-note`(info)로 "직접 지정이 우선"임을 안내한다.
- **Regression(A~K)**: `tests/integration/schedule-rule-override.test.ts`(A~J, RPC/DB 레벨
  매트릭스), `tests/e2e/admin/membership-schedule-rules.spec.ts`(B는 유지, D+F+K/J는 새
  정책에 맞게 갱신 — 옛 정책 하에서 "차단"을 기대하던 부분이 새 정책에서는 "사용 가능"으로
  뒤집힘).


### P1-14. (2026-08-10, 해결 완료) `attendance-policy.test.ts` 주간 대기예약 한도 초과로 Integration 반복 실패

| 필드 | 내용 |
|---|---|
| 우선순위 | 해결됨(과거 P1) |
| 현재 상태 | **완료. cleanup SQL 사용자가 직접 적용(C-1: memberB_centerA_waitlisted_remaining=0) → read-only 독립 재검증 2회(0건) → 재발 방지 코드(admin 기반 cleanup + self-healing) 커밋 → 전체 CI(E2E/Unit/Integration/Build) 2회 연속 Green, 둘 다 first-attempt·재시도 없음(run `31367089839`, `31368870324`) → Vercel Preview 성공 확인** |
| 근거 파일 | `tests/integration/attendance-policy.test.ts`, `tests/integration/setup.ts`(`cleanupTestClassAdmin`), `reservation_functions.sql`(RLS DELETE 정책 — 원인 파악용, 미수정), `cleanup_p1_14_waitlisted_test_pollution_draft_proposed.sql`(사용자가 Supabase SQL Editor에서 적용 완료) |
| 완료 조건 | ~~cleanup SQL 적용 후 재검증~~ 전부 완료 |

- **증상**: run `31356042673`부터 `31362464170`까지 Integration job이 4회 연속으로 정확히
  같은 2개 테스트에서 동일 에러로 실패: `예약 실패: 이번 주 대기예약 가능 횟수(10회)를
  초과했어요`. 같은 run들에서 E2E(TEST1/TEST2/TEST4/TEST5/TEST6 포함)와 Unit은 매번 Green.
- **실측 진단(CI run 31362464170, 임시 read-only 진단 파일로 확인 후 삭제)**: memberB
  (TEST_USER_B, profile `f2c9749a-b282-433b-8b60-a982b81a53f3`)의 waitlisted reservations가
  centerA에 정확히 13건 존재. **13건 전부** class title이 정확히 `P3 출결-대기거부`(다른
  title은 0건), created_at은 2026-08-07~2026-08-09에 걸쳐 분산(거의 매 실행마다 1건씩).
  memberA의 waitlisted는 0건.
- **근본 원인(코드로 확정, 추측 아님 — 이전 기록의 "self-inflicted 아님" 결론은 정정함)**:
  `reservation_functions.sql`의 "매니저 취소예약 정리" RLS DELETE 정책(`reservations`,
  `status in ('cancelled','no_show')`만 허용)과, "정원이 찬 그룹 수업에서 대기로 등록된
  예약은 attended로 바꿀 수 없다" 테스트가 **의도적으로 waitlisted 상태로 남기는** 예약
  (그 상태를 유지한 채 가드를 검증하는 게 테스트의 목적 자체) 사이의 범위 불일치. 옛
  `afterAll`은 매니저 세션(RLS 적용) 기반 `cleanupTestClass()`로 지웠는데, 이 정책이
  waitlisted를 허용하지 않아 `DELETE`가 **에러 없이 조용히 0건 삭제**로 끝났다(Postgrest가
  RLS에 안 걸리는 행을 그냥 매칭 안 된 것으로 처리 — 예외 아님). **완전히 동일한 원인이
  `private-class-capacity.test.ts`에서 이미 한 번 발견·우회된 적이 있었음**(그 파일 자체
  주석, `admin_cancel_reservation`이 MEMBER 타입 예약을 거부해 세션 기반 delete가 조용히
  막히는 사례) — 그 교훈이 `attendance-policy.test.ts`에는 전파되지 않았던 것.
- **재발 방지(코드 수정 완료, 커밋됨)**: `tests/integration/setup.ts`에 `cleanupTestClassAdmin(classId)`
  추가(admin/service_role 기반 — RLS를 우회하므로 예약 상태와 무관하게 확실히 삭제).
  `attendance-policy.test.ts`의 `afterAll`을 이 함수로 전환하고, `beforeAll`에 이 파일 전용
  5개 title("P3 출결-*")에 대한 self-healing 사전 정리를 추가(get-or-create/self-healing
  패턴, TEST4의 `cleanupBuyProductMemberships`와 동일 스타일) — 이후로는 이 파일이 CI
  취소/실패로 `afterAll`을 못 돌아도 다음 실행의 `beforeAll`이 스스로 정리한다.
- **과거 누적분 정리 SQL**: `cleanup_p1_14_waitlisted_test_pollution_draft_proposed.sql` —
  profile_id(memberB 정확한 UUID) + center_id(centerA 정확한 UUID) + class title 정확히
  일치("P3 출결-대기거부", LIKE 없음) + status='waitlisted' 4중 조건, `admin_action_logs`
  참조 NOT EXISTS 가드, A(read-only preview)/B(단일 트랜잭션 atomic cleanup)/C(post-commit
  검증) 구조. **참고**: 이 13개 class는 각각 memberA의 아직 살아있는 confirmed 예약도 함께
  갖고 있어(정원 1명을 memberA가 먼저 채우는 테스트 구조), class 자체는 이번 정리 후에도
  남을 가능성이 높다(안전한 의도된 동작 — 오늘 실패의 원인인 waitlisted 건수와는 무관, 남은
  class 누적은 별도의 기존 이슈 RES-002/TEST-004 계열).
- **cleanup SQL 실행 완료(2026-08-10, 사용자)**: C-1 검증 `memberB_centerA_waitlisted_remaining=0`
  확인. read-only 재검증(CI run `31365334512`)으로 독립적으로도 0건 재확인.
- **사후 검증 중 발견한 2차 이슈(코드 수정 완료, 커밋됨)**: cleanup SQL 적용 직후 재실행한
  CI(`31365334512`)의 Integration이 여전히 실패 — 그러나 증상이 달라짐: 원래의 "주간
  대기예약 한도 초과"가 아니라 `Hook timed out in 30000ms`(attendance-policy.test.ts의
  `beforeAll`). read-only로 확인한 결과 memberB의 waitlisted는 이미 0건이라 원래 버그의
  재발이 **아니었음** — 원인은 beforeAll의 self-healing sweep이 class 하나당
  `cleanupTestClassAdmin()`을 순차 await로 호출했는데, cleanup SQL이 손대지 않은 다른 3개
  title("P3 출결-대기취소" 8건/"타센터차단" 9건/그 외)에 과거부터 쌓여있던 잔여 class가
  총 24건이라 순차 round-trip(최대 48회)이 vitest `hookTimeout`(30000ms)을 실제로 초과한
  것(성능 문제, 앱 버그도 재발도 아님 — test bug). **타임아웃 값을 올리는 우회는 쓰지
  않고**, class id들을 모아 `reservations`/`classes` 각 1회씩 bulk delete로 바꿔
  round-trip 수 자체를 없앴다(원인 제거, 증상 은폐 아님). 이 변경은 부수적으로 다른 4개
  title에 쌓여있던 24건의 역사적 잔여 class도 이번 실행에서 함께 정리한다(전부 이 파일
  전용 리터럴 title, 동일한 안전 근거).
- **최종 재검증(2026-08-10)**: bulk delete 수정을 반영한 CI 2회 연속 실행 — 둘 다
  전체(E2E/Unit/Integration/Build) Green, first-attempt(재시도 없음): run `31367089839`
  (pull_request), `31368870324`(workflow_dispatch), 둘 다 headSha `80889d7`.
  `attendance-policy.test.ts` 5/5 통과(각 ~37.5초, 재시도 없음). 두 run 모두 독립적인
  read-only 진단으로 memberB centerA waitlisted=0, "P3 출결-*" 5개 title 전부 잔여 class/
  reservation 0건 재확인 — 두 번째 run은 이 파일이 그 사이에 waitlisted 예약을 새로
  만들었다가 afterAll이 정상적으로 지운 뒤의 상태라, "우연히 DB가 깨끗했다"가 아니라
  "cleanup 로직 자체가 구조적으로 작동한다"는 것을 실제로 증명함. 진단용 임시 파일
  (`tests/integration/zzz_diag_p1_14_postcleanup_verify.test.ts`)은 검증 완료 후 삭제.
  Vercel Preview도 같은 headSha 기준 배포 성공 확인.

### P2-20. (2026-08-09, 해결됨) class_allowed_products 선택이 저장 직후 재진입 시 사라짐 + `.pass-pick-list` 미표시

| 필드 | 내용 |
|---|---|
| 우선순위 | 해결됨(과거 P2) |
| 현재 상태 | **완료 — goal1/goal2 모두 원인 확정·수정·검증 완료. cleanup SQL 사용자가 직접 적용(891→5건), 임시 진단 계측 전부 제거. class-allowed-products.spec.ts 3연속 Green, 전체 CI(E2E/Unit/Integration/Build) 3연속 Green, Vercel Preview 성공 확인** |
| 근거 파일 | `app/manager/classes/page.tsx`(`openEdit`, `openTokenRef`/`userEditedRef`), `lib/reservations.ts`(`fetchUsableMembershipsByClass`), `cleanup_p2_20_e2e_test_pass_duplicates_draft_proposed.sql`(적용 완료) |
| 완료 조건 | ~~cleanup SQL 적용 후 재검증~~ 전부 완료 |

- **goal1 (관리자 화면 선택 사라짐) — 원인 확정, 수정 완료**: `openEdit()`의 초기
  `fetchClassProducts()` hydrate 응답(~340ms)이 사용자의 chip 클릭보다 늦게 도착하면
  `setSelectedProducts(ids)`가 무조건 실행돼 사용자의 선택을 덮어썼다(특히 새 class라
  DB 스냅샷이 빈 배열일 때 조용히 초기화됨). `openTokenRef`(요청 세대 비교) +
  `userEditedRef`(dirty flag) 가드를 추가해 `isStale = myToken !== openTokenRef.current
  || userEditedRef.current`일 때만 적용을 건너뛰도록 구조적으로 수정 — CI로 재현/수정
  둘 다 실측 확인함(`APPLY_FETCH_RESULT`가 `applied:false`로 정확히 스킵되는 것을 확인).
- **goal2 (`.pass-pick-list` 미표시) — 원인 확정**: `lib/reservations.ts`의
  `fetchUsableMembershipsByClass()`가 `usable_memberships_for_classes` RPC 응답을
  `.range()`로 1000행씩 순차 페이지네이션한다. TEST_USER_A의 centerA 소속
  membership 891건(아래 원인)이 class당 ~744행이라는 거의 상수 크기의 RPC 응답을
  만들어내고, 실패 재현 조건(수업 36개)에서 클라이언트가 이를 **27번 순차 왕복**해서
  받아온다 — 실측 총 12.4~13.9초(page당 ~300~1100ms). 관측된 ".pass-pick-list가
  10초 넘게 안 뜸" 증상과 정확히 일치(수업 8개일 땐 6페이지·1.6~1.9초로 재현 안 됨,
  그래서 작은 케이스에선 정상 동작). RPC 서버 실행 자체는 항상 빠름(단일 호출
  0.3~0.9초) — "membership이 많으면 느리다"가 아니라 "많으면 응답이 커져서 클라이언트
  왕복 횟수가 늘어난다"는 점을 CI 실측으로 검증함(추측 아님).
- **원인(historical duplicate memberships)**: centerA(3937eb89-...)에 `product_name=
  'E2E 테스트 수강권'`인 memberships가 profile_id 무관 891건(userA 827 + 다른 테스트
  프로필 64) 쌓여 있었다 — `createTestMembershipAdmin()`이 get-or-create로 수정되기
  전에 CI 반복 실행(특히 취소된 실행이 `afterAll`을 건너뛴 경우)으로 누적된 것.
- **cleanup SQL 적용 완료(2026-08-09)**: `cleanup_p2_20_e2e_test_pass_duplicates_draft_proposed.sql`
  — 정확한 product_name+center_id로 식별, 6개 FK 테이블(reservations/payments/
  membership_transfers/product_passes/contracts/admin_action_logs) 전부 NOT EXISTS로
  제외(참조 있는 membership은 절대 안 지움). 첫 시도는 사용자가 BEGIN+DELETE와 COMMIT을
  Supabase SQL Editor의 서로 다른 두 번의 Run으로 나눠 실행해 커넥션 풀링으로 세션이
  갈리는 바람에 COMMIT이 실제로는 아무것도 커밋 못 하고 DELETE가 자동 rollback되는 문제가
  실측 발견됨(891/1557 그대로) — A(read-only preview)/B(BEGIN~COMMIT을 한 번의 Run으로,
  내부 4중 검증 후 자동 커밋/롤백)/C(post-commit verification) 구조로 재작성 후 사용자가
  한 번의 Run으로 재실행해 성공. 결과: centerA의 "E2E 테스트 수강권" 891→5건(FK로 보존된
  것만), TEST_USER_A 전체 memberships 1557→730건. 전부 read-only 재검증으로 확인함(P5).
- **RPC 페이지네이션 루프 재측정(P5, cleanup 후)**: n=1 1페이지/291ms(이전 744행/1페이지),
  n=8 1페이지/251ms(이전 6페이지/5952행/1.6~1.9초), **n=36 2페이지/1908행/1068ms**(이전
  27페이지/26784행/12.4~13.9초) — 12배 이상 개선, `.pass-pick-list` 미표시 증상이 실제로
  해소됨을 CI에서 실측 확인.
- **임시 진단 계측 전부 제거 완료(P7, 2026-08-09)**: `lib/_diag220.ts`,
  `tests/integration/_diag_memberships.test.ts` 삭제, 4개 파일의 `diagEvent` 호출/import
  전부 제거(프로덕션 로직은 그대로 유지), `.github/workflows/test.yml`의 `diag` job/
  `diag_only` input 제거해 원래 구조로 복원. `npm run build` 통과 확인.
- **최종 검증(P5~P9)**: class-allowed-products.spec.ts 3연속 Green(5/5 테스트, goal1/goal2
  둘 다 포함), 전체 CI(E2E/Unit/Integration/Build) 3연속 Green, Vercel Preview 배포 성공
  확인. P4 sales dashboard 회귀 없음(`dashboard-summary.test.ts` 7/7, Integration 112/112,
  Unit 203/203 전부 통과).
- **(발견, 별도 이슈로 기록) `daily-book-limit.spec.ts`의 기존에 이미 문서화된 인프라
  플레이키니스 1회 재현**: 최종 3연속 CI 중 마지막 회차에서 이 파일의 테스트가 1회
  실패(`.sheet-overlay` 모달이 예약 확정 클릭 후 10초 안에 안 닫힘) 후 재시도에서 성공.
  P2-20이 건드린 파일(`app/reservation/page.tsx` 등)과 무관함을 `git diff`로 직접 확인함
  (diagEvent 호출 제거 외 로직 변경 없음). 이 테스트 파일 자체의 기존 주석에 이미
  "CI dev 서버가 짧은 시간에 몰리는 요청 중 하나를 드물게 못 끝내는 경우가 실측 확인됨"이라고
  기록돼 있고 타임아웃을 120초로 이미 늘려둔 상태 — 새 회귀가 아니라 기존에 알려진 인프라
  노이즈의 재발로 판단, 이번 배치에서 추가 조치 안 함.
- **(신규) `membership_transfers`/`product_passes`/`contracts`도 service_role SQL
  GRANT 없음**: 이번 진단에서 이 세 테이블에 대한 count 조회가 전부 빈 에러 객체
  (`code/message/details/hint` 전부 undefined)로 실패 — `payments`/`admin_action_logs`/
  `accounts`(아래)와 같은 계열(P2-13). cleanup SQL은 이 GRANT gap과 무관하게 NOT EXISTS로
  방어하도록 설계해 안전성에는 영향 없음 — GRANT 자체를 고치는 것은 이번 범위 밖.
- **(신규) `accounts` 테이블도 service_role SQL GRANT 없음**: 교차검증 쿼리가
  `"permission denied for table accounts"`로 실패 — `payments`(P4에서 발견)/
  `admin_action_logs`/`membership_transfers`/`product_passes`/`contracts`/
  `locker_assignments`/`point_transactions`/`progress_records`와 같은 계열(P2-13).
  이번 배치에서 GRANT SQL을 만들지 않음(진단은 `profiles`만으로 충분히 확인됨) — 향후
  admin 클라이언트로 이 테이블에 직접 접근해야 하는 테스트가 생기면 그때 추가.
- **(신규, P6 — 별도 후속 작업) `usable_memberships_for_classes` RPC/클라이언트 페이지네이션
  구조 감사 필요**: 이번 진단으로 RPC 서버 실행 자체는 항상 빠름(0.3~0.9초)을 확인했지만,
  `fetchUsableMembershipsByClass()`의 `.range()` 순차 페이지네이션은 회원이 보유한
  "이 조건에 맞는 membership 행 수 × 조회하는 class 수"에 선형으로 왕복 횟수가 늘어나는
  구조다 — 이번엔 테스트 계정의 historical duplicate가 원인이었지만, 실제 서비스에서
  회원이 정상적으로 수백 건의 membership을 보유하고 한 번에 수십 개 class를 조회하는
  경우(예: 한 달 캘린더 전체 로드) 같은 방식으로 여러 번 순차 왕복이 발생할 수 있다.
  프로덕션 RPC/클라이언트를 지금 수정하지 않음(실제 문제가 증명되지 않았는데 추측성으로
  고치지 말라는 원칙) — 실제 서비스 규모의 회원 데이터로 별도 측정 후 필요성이 확인되면
  그때 (a) RPC 안에서 `profile_id`/`center_id`를 더 일찍 필터링하는지, (b) 클라이언트가
  전체를 한 번에 순차 페이지네이션하는 대신 필요한 만큼만 요청하도록 바꿀지 검토할 것.
- **(신규, P6 조사 중 발견 — 별도 후속 작업) `lib/reservations.ts`의 `fetchMonthData()`가
  회원 자신의 `memberships`를 조회하는 쿼리(`myMems`, 91-95행)가 페이지네이션 없이
  `.in("profile_id", myProfileIds)` 한 번만 호출한다** — 바로 아래 `classRows` 쿼리는
  같은 이유(PostgREST 1000행 응답 캡)로 이미 `.range()` 루프로 고쳐져 있는데, `myMems`는
  아직 안 고쳐진 채로 남아 있다. 이번 cleanup 전 진단에서 TEST_USER_A가 정확히 1000건
  (캡에 걸린 값)으로 관측된 것이 이 쿼리였다 — 실제 회원이 1000건 넘는 memberships를
  보유하면(가능성은 낮지만 구조적으로는 가능) 일부 센터의 활성 수강권이 누락돼
  `membershipCenterIds` 계산이 틀어지고, 그 회원이 그 센터 수업을 못 보게 될 수 있다.
  이번 배치에서는 P2-20 범위 밖이라 수정하지 않음(cleanup 후 TEST_USER_A도 730건으로
  캡 밑으로 내려가 현재는 증상 재현 안 됨) — `fetchClasses`/`fetchUsableMembershipsByClass`와
  동일한 패턴으로 `.range()` 페이지네이션을 추가하는 것을 향후 별도 작업으로 검토할 것.

- **실제 원인(읽기 전용 진단으로 직접 확인, 추측 아님)**: 거의 모든 integration/e2e 테스트가
  `getOrCreateOwnedTestCenter(managerA)`로 **단 하나의 공유 센터**를 재사용하는데, 그 안의
  `memberships`가 PostgREST 기본 1000행 응답 캡에 걸릴 만큼 누적돼 있었다(진단 시점 캡 안에서만도
  "통합테스트 수강권" 979건 등). `class-allowed-products.spec.ts`는 이 프로필의 "사용 가능한
  수강권" 전체를 화면에 나열하는데, 그 목록이 수백~수천 건이 되면서 검색/카운트 검증이
  타임아웃·간헐 실패했다 — class_allowed_products 기능 자체의 버그가 아니었다.
- **근본 원인 코드**: `createTestMembership()`(setup.ts), `createTestMembershipAdmin()`/
  `createTestGoodsMembershipAdmin()`(e2e/fixtures/testData.ts, 11개 이상의 spec이 사용),
  `class-allowed-products-enforcement.test.ts`의 로컬 `createMembershipForProduct()`,
  `usable-memberships-pass-kind.test.ts`의 인라인 products/memberships insert — 전부
  get-or-create 없이 호출마다 새 행을 만들었다. `afterAll` 정리가 있는 파일도 CI가 그 테스트
  도중 취소되면(GitHub Actions `concurrency.cancel-in-progress`, 또는 사람이 새 실행을 다시
  트리거) `afterAll` 자체가 실행되지 않아 그대로 남는다 — 이 세션에서만도 CI를 여러 번 연속
  재트리거하며 실제로 이 경로로 쌓임을 확인함.
- **코드 수정 완료(이번 배치)**: 위 다섯 곳 전부 `createTestMembershipForProduct()`가 이미
  증명한 get-or-create + self-healing refresh 패턴으로 교체 — 앞으로는 같은 방식으로 다시
  쌓이지 않는다. `attendance.spec.ts`는 추가로 `beforeAll`에 고아 프로필("P3 출결-대기용",
  `afterAll` 미실행 시 남음) 자체 정리 스윕을 추가했다.
- **SQL 정리(적용 대기)**: `cleanup_shared_test_center_pollution_draft_proposed.sql` — 지금까지
  이미 쌓인 데이터(1회성)를 정리. 대상은 정확한 문자열/계정으로 식별되는 테스트 전용 데이터만
  (진단 결과 "그 외 profile_id 0건" 확인, 실사용자/실센터 데이터 아님). BEGIN/COMMIT +
  미리보기 카운트 + 예상 범위 벗어나면 RAISE EXCEPTION 가드 포함.
- **범위 밖 → 이슈로 분리됨(2026-08-10, [TEST-004 #45](https://github.com/sonjw222/booking-app/issues/45))**:
  같은 진단에서 `classes` 테이블도 1000행 캡에 걸릴 만큼 누적돼 있음을 발견
  (`admin-assignment-security.test.ts`의 "성공경로-*" 시나리오만 최소 914건,
  `P1-12`/`RES-001`/`CLASS-001`/`SETTINGS-REAUDIT` 등 추가). 이 파일들은 이미 `afterAll`로
  정리하도록 설계돼 있어(get-or-create 부재 문제가 아님) — 근본 원인은 "CI 취소 시 afterAll
  미실행"과 동일 계열이지만, 파일마다 시나리오별 고유 데이터라 get-or-create 전환이
  부적절하고, `beforeAll` 자체 정리 스윕을 5개 이상 파일에 각각 설계해야 하는 더 큰 작업이다.
  class-allowed-products.spec.ts의 현재 실패와 직접 관련 없어 P2-20 배치 범위에서는 제외했고,
  **다음 안정화 배치의 확정 우선순위**로 TEST-004에 반영함(TEST-002 #24와 같은 근본 원인
  계열로 함께 검토 권장).

### 다음 안정화 배치 확정 우선순위 (2026-08-10, PR #44 리뷰 중 확정)

P2-20 조사 과정에서 발견됐지만 이번 배치 범위 밖이라 코드 수정 없이 이슈로만 분리한
3건 — 다음 안정화 배치에서 이 순서로 착수할 것을 확정한다.

| 순위 | 이슈 | 요약 | 근거 |
|---|---|---|---|
| 1 | [RES-002 #42](https://github.com/sonjw222/booking-app/issues/42) | `fetchMonthData()`의 `myMems` 쿼리가 PostgREST 1000행 캡 미대응 | **2026-08-11 완료** — `classRows`/`fetchUsableMembershipsByClass`와 동일한 `.range()` 페이지네이션을 `myMems`에도 적용(`lib/reservations.ts`). 회귀 테스트 `tests/integration/month-data-memberships-row-limit-regression.test.ts` 추가(1005개 필러 membership 뒤의 target membership이 여전히 감지되는지, 자녀 프로필 공유 구조도 함께 확인). SQL 변경 없음(순수 코드 수정). 전체 CI 2연속 Green으로 검증됨(run `31459078105`/`31460392240`) |
| 2 | [TEST-004 #45](https://github.com/sonjw222/booking-app/issues/45) | `classes` 테이블 공유 테스트센터 오염(1000행 캡, 최소 914건) | **2026-08-11 완료** — 재진단 결과 실제로는 1761건까지 누적(22개 title_prefix 그룹, 최대 기여자: `admin-assignment-security.test.ts`의 "성공경로-*" 8종 ~812건, `diagnose-settings-live-values.test.ts`의 "DIAG 일일한도" 141건 등). `tests/integration/setup.ts`의 `getOrCreateOwnedTestCenter()`에 self-healing sweep을 추가(start_time이 1시간 이상 과거인 class를 해당 테스트센터에서 자동 정리) — 사실상 모든 통합 테스트 파일이 이 함수를 beforeAll에서 호출하므로 파일마다 정리 로직을 따로 만들지 않고 스위트 전체가 자동으로 self-healing된다. 별도로 `diagnose-settings-live-values.test.ts`(RLS 기반 `cleanupTestClass` 사용 — confirmed 상태 예약의 delete가 조용히 실패해 **매 실행 결정적으로 leak**하던 실제 원인 발견)를 `daily-book-limit-wiring.test.ts`로 정리(당일예약 describe는 `operational-settings-wiring.test.ts`와 완전 중복이라 제거, 일일한도 describe는 admin 기반 cleanup으로 교체해 유지). 이미 쌓인 1761건은 별도 cleanup SQL 없이 CI 실행에서 sweep이 자동으로 정리함(모두 start_time이 이미 과거라 즉시 대상) — SQL 불필요. 전체 CI 2연속 Green으로 검증됨(run `31459078105`/`31460392240`) |
| 3 | [TEST-003 #43](https://github.com/sonjw222/booking-app/issues/43) | `daily-book-limit.spec.ts` 잔여 CI 인프라 플레이키니스 | **2026-08-11 완료** — 실제 실패 로그(run `31393468107`)를 직접 조사해 "그냥 flaky"로 단정하지 않고 정확한 원인 추적: `app/reservation/page.tsx`의 `doReserve()`/`handleCancel()`이 RPC 성공 → 시트 닫힘 → `await load()`(전체 재조회) 순서로 동작해, 시트가 닫히는 시점과 `.class-row` 버튼이 "예약"↔"취소"로 갱신되는 시점 사이에 실제 간격이 있음을 확인. 이 파일은 예약/취소 왕복을 최대 9회 반복해 CI 부하 시 그 간격이 Playwright 기본 expect timeout(10초)을 넘기는 사례가 실측됨(첫 시도 실패 → 재시도 통과, 앱/RPC 버그 아님 — 예약 자체는 이미 성공한 뒤였음). 분류: CI 인프라/타이밍(app bug/test bug 아님). 수정: 정확히 이 버튼 상태 assert 5곳만 timeout을 20초로 늘림(무조건적인 전체 timeout 증가 아님, 진단된 병목에만 적용). 전체 CI 2연속 Green으로 검증됨(run `31459078105`/`31460392240`) |

### P2-22. (신규, 2026-08-13 / 2026-08-14 leftover 정리 완료) `getOrCreateOwnedTestCenter()` self-healing sweep이 미래 시각 leftover class는 못 잡음 — AUTO-SEC-I 간헐 실패 원인

| 필드 | 내용 |
|---|---|
| 우선순위 | P2 (테스트 인프라 한정 — 보안 로직과 무관, SEC-114 배치 범위 밖) |
| 현재 상태 | **이미 쌓인 leftover 318건 정리 완료(cleanup_p2_22_shared_center_class_fixtures_draft_proposed.sql, 사용자 실행·검증 완료). 근본 원인(sweep이 미래 시각은 안 잡음) 자체는 코드 수정 안 함 — 재발 가능성 있음, 아래 완료 조건 (a) 참고** |
| 근거 파일 | `tests/integration/setup.ts`(`getOrCreateOwnedTestCenter()`의 sweep, TEST-004 #45), `tests/integration/auto-book-membership-security.test.ts`(`AUTO-SEC-I`), `cleanup_p2_22_shared_center_class_fixtures_draft_proposed.sql`(신규, 적용 완료) |
| 완료 조건 | (a) sweep 조건을 "과거"뿐 아니라 "제목이 알려진 테스트 fixture 패턴이고 미래인 것"까지 넓혀서 재발 자체를 막을 것(아직 안 함 — 이번엔 이미 쌓인 것만 1회성으로 정리) |

**2026-08-14 leftover 정리 완료**: 제목 리터럴을 나열하는 대신 구조적 기준(이 하나의 공유
테스트센터 + `status='open'` + `start_time > now()` + `created_at`이 1시간 이상 과거 — 지금
막 어떤 세션이 만든 class까지 실수로 지우지 않기 위한 안전 마진)으로 `cleanup_p2_22_shared_
center_class_fixtures_draft_proposed.sql` 작성. 사용자가 read-only 진단(A)으로 318개 class/
237개 딸린 reservation을 먼저 확인(예상 범위 내, 안전 상한 3000건의 10분의 1 수준) → 삭제(B,
BEGIN/COMMIT 트랜잭션) 실행 → 검증(C)에서 `remaining_target_classes=0`, 이 센터에 정상적으로
남아야 할 263건은 그대로 보존됨을 확인. rollback 파일은 순수 DELETE라 SQL로는 되돌릴 수 없다는
설명 안내(P3 SEC-MC cleanup과 동일한 패턴) — 지워진 행은 전부 자동화 테스트 전용 leftover라
"복구"가 아니라 "다음에 그 테스트가 필요할 때 다시 만들어내는 것"이 정답.

- TEST-004 #45가 추가한 sweep은 `start_time`이 1시간 이상 **과거**인 class만 정리한다. 그런데
  SEC-101/112/113~117 회귀 테스트 중 `auto-book-membership-security.test.ts`를 로컬로 처음
  실행하며 `AUTO-SEC-I`(정상 자동예약의 예약 수/잔여횟수 정합성, `expect(booked).toBe(2)`)가
  `booked=3`으로 실패했다. 원인 진단(read-only) 결과, managerA 소유 공유 테스트센터
  (`3937eb89-3803-43e9-9a29-e893f779df1a`)에 `status='open'`이고 `start_time`이 **미래**(짧게는
  며칠, 길게는 2026-09-12/2026-11-11까지)인 leftover class가 300개 이상 남아있었다 —
  `P3 통합-*`, `E2E 한도*`, `CLASS-001 기본값사용`, `SETTINGS-REAUDIT *`, `P1-12 *`, `P2
  알림격리-*`, `DIAG-NEWCLASS-BUG *` 등 여러 파일/세션의 잔재. 이 중 다수가
  `class_allowed_products` 제한이 전혀 없어서, `auto_book_membership()`(SEC-114 수정 대상)의
  "센터+요일만 일치하면 예약 가능" 매칭 로직이 새로 만든 테스트 수업뿐 아니라 이 leftover들도
  같은 요일이면 함께 집어 예약해버린다.
- **SEC-114 보안 수정 자체와는 무관함을 확인**: `auto_book_membership()`의 business logic(요일
  매칭, class_allowed_products 필터, 하루 1개 제한, 정원 체크)은 이번 세션에서 한 줄도 바꾸지
  않았다(authorization 블록만 추가, `fix_auto_book_membership_idor_draft_proposed.sql` 헤더
  참고) — leftover 오염이 없었다면 기존 코드로도 정확히 2개만 잡혔을 것. 같은 파일의
  `AUTO-SEC-J`(멱등성 — 같은 membership으로 재호출해도 중복/초과 차감이 없는지)는 정확한
  개수가 아니라 "두 번째 호출은 0개"만 확인하는 방식이라 이 오염에 영향받지 않고 통과했다.
- 대량(300건+) 삭제이고 `reservations`/`attendance` 등 FK 연쇄 영향 범위를 파일별로 다시
  조사해야 해서, 이번 보안 배치 범위에서 임의로 cleanup SQL을 작성·적용하지 않았다. sweep
  조건을 미래까지 넓히는 것도 "다른 테스트가 지금 막 만든, 아직 안 끝난 미래 class"까지
  지워버릴 위험이 있어 신중한 설계가 필요하다.

아래 항목은 스키마 또는 권한 근거만 있고 완성된 앱 흐름이 없습니다. 사용자·제품 결정 없이 구현 또는 삭제하지 않습니다.

### P3-1. 수업 구분과 복수 강사 배정

**복수 강사 배정 — 2026-08-11 로드맵 포함 결정 + 구현 + SQL 2건 적용 + CI 2연속 Green
으로 최종 완료**: `class_trainers` 재사용, `classes.pass_selection_mode` 신규 컬럼
(수강권 허용 정책 0건=전체허용 → 명시적 선택제로 변경, 관련 결정)까지 한 배치로 처리함.
관리자 UI(`app/manager/classes/page.tsx` 수업 등록/수정 시트에 담당 강사 다중 선택 +
전체 선택/전체 해제 버튼 + 0개 선택 시 저장 차단), `lib/classes.ts`/`lib/reservations.ts`,
신규 통합 테스트(`tests/integration/class-trainers-and-pass-selection-mode.test.ts`)까지
완료. SQL 2건 모두 사용자가 Supabase에 실행 완료:
1. `add_class_trainers_pass_selection_mode_draft_proposed.sql` — read-only로 migration
   결과 확인(`all`=389/`selected`=85/합계 474, 헤더 주석 예고치와 정확히 일치).
2. `add_class_trainer_names_rpc_draft_proposed.sql` — CI 통합 테스트로 회원 세션에서
   `accounts` RLS 때문에 담당 강사 이름이 항상 빈 값으로 나오던 실제 버그를 발견해
   추가한 좁은 security definer RPC(`class_trainer_names`, public/anon EXECUTE 명시적
   차단 + `auth.uid() is not null` 이중 방어). anon 호출이 401 permission denied로
   정상 차단됨을 read-only로 확인.

전체 CI(E2E/Unit/Integration/Build) **2연속 Green**으로 최종 검증됨(run
`31487777454`/`31489758487`, 둘 다 first-attempt·재시도 없음 — E2E 45/45, Unit
213/213, Integration 133/133). 기존 P0~P4/P1-15/P1-17 관련 테스트 파일
(`schedule-rule-override.test.ts`, `class-allowed-products-enforcement.test.ts`,
`admin-assignment-security.test.ts`, `private-class-capacity.test.ts` 등) 전부 회귀
없이 통과. 상세는 `docs/CHANGELOG.md` 2026-08-11 항목들 참고.

**수업 구분(class_types, classes.class_type_id) — 여전히 미결정**: 이번 배치 범위 밖.

| 필드 | 내용 |
|---|---|
| 우선순위 | P3 |
| 현재 상태 | **확인 필요(수업 구분만 남음 — 복수 강사 배정은 위에서 해결됨)** |
| 근거 파일 | `schema.sql`, `reservation_functions.sql`; `class_types`, `classes.class_type_id` |
| 완료 조건 | 수업 구분 기능의 제품 포함 여부를 결정함. 포함 시 수업 CRUD·권한·기존 수업 migration을 구현하고, 제외 시 FK·운영 데이터·외부 사용을 확인한 정리 계획을 승인받음 |
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
