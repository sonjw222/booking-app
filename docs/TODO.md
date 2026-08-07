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
- **알림 카테고리가 8개가 아니라 4개뿐이고 서버가 이 설정을 전혀 읽지 않음**: `app/settings/notifications/page.tsx`의
  알림 설정은 `localStorage`에만 저장되고(`reservation`/`waitlist`/`reminder`/`marketing` 4종),
  모든 서버 트리거(`trg_notify_reservation_insert/_update`, `send_inquiry_message` 등)는 이
  설정과 무관하게 항상 알림을 생성한다. 사용자가 요청한 "공지/결제/문의답변" 등 5개 카테고리
  확장 및 실제 서버측 필터링(수신거부 반영)은 DB 테이블 신설 + 모든 알림 생성 지점 수정이
  필요한 훨씬 큰 작업이라 이번 배치에서는 제외하고 여기 기록만 한다 — 제품 결정 필요.
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
- **TEST-002(#24)의 알려진 오염이 다른 파일에도 영향을 준다는 것을 재확인**: `acl-003-permission-read.test.ts`가
  남기는 "MANAGER_B가 centerA의 활성 스태프가 됨" 오염 상태 때문에, 이번 배치가 새로 추가한
  `tests/integration/inquiry-access-isolation.test.ts`의 "다른 센터 매니저는 못 본다" 케이스와
  기존 `admin-assignment-security.test.ts`의 "다른 센터 관리자는 배치 못 함" 케이스가 같은 CI
  실행에서 함께 실패하는 것을 관측함(둘 다 설계·코드 문제 아님, RLS/RPC는 "활성 소속 여부"를
  정확히 설계대로 검사 중 — #24 해결 전까지는 테스트 실행 순서에 따라 이 두 케이스가 간헐적으로
  RED일 수 있음).

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
