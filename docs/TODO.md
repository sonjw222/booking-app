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
| 현재 상태 | **미완성** |
| 근거 파일 | `app/checkout/page.tsx`, `app/cart/page.tsx`, `lib/orders.ts`, `add_orders.sql`, `schema.sql` |
| 완료 조건 | 승인된 PG로 결제 생성·성공·실패·취소·중복 callback을 검증하고, 성공 주문만 발급되며 `orders`·`payments` 상태가 일치함. 테스트 결제와 환불 결과를 기록함 |
| 관련 문서 | [REQUIREMENTS 6-1, 10-4](./REQUIREMENTS.md), [DATABASE 4-3, 7-3](./DATABASE.md), [ROUTES `/checkout`](./ROUTES.md) |

현재 “결제하기”는 `orders.status = pending` 주문만 만들고 매니저가 수동 발급합니다. 예약 화면으로 복귀하는 UX가 실제 결제·즉시 발급을 뜻하지 않도록 유지해야 합니다.

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

### P0-5. 정기 알림 스케줄러

| 필드 | 내용 |
|---|---|
| 우선순위 | P0 |
| 현재 상태 | **운영 설정 필요** |
| 근거 파일 | `add_notifications.sql`, `README.md`; 함수 `notify_upcoming_reservations()`, `notify_expiring_passes()` |
| 완료 조건 | 운영 Supabase의 pg_cron 또는 승인된 scheduler가 정해진 주기로 두 함수를 실행하고, 중복 없이 알림이 생성되는 것을 운영 또는 staging에서 확인함 |
| 관련 문서 | [REQUIREMENTS 6-2](./REQUIREMENTS.md), [DATABASE 9-3, 12-5](./DATABASE.md) |

함수 존재만으로 자동 알림이 실행되는 것은 아닙니다.

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

### P1-6. 관리자·운영자 클라이언트 가드 누락

| 필드 | 내용 |
|---|---|
| 우선순위 | P1 |
| 현재 상태 | **미완성** |
| 근거 파일 | `app/admin/categories/page.tsx`, `app/admin/banners/page.tsx`, `app/manager/inquiries/page.tsx`, `app/manager/notifications/page.tsx`, `app/manager/staff/permissions/page.tsx` |
| 완료 조건 | 플랫폼 운영자 2개 화면과 매니저 3개 화면에 일관된 사전 가드를 적용하고 비권한 사용자의 콘텐츠 미노출·친절한 오류·RLS 차단을 검증함 |
| 관련 문서 | [REQUIREMENTS 7~8절](./REQUIREMENTS.md), [ROUTES 5~7절](./ROUTES.md), [DATABASE 10절](./DATABASE.md) |

현재 데이터 쓰기는 RLS가 막지만 화면과 입력폼이 먼저 노출되는 페이지가 있습니다.

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
| 관련 문서 | [REQUIREMENTS 6-3, 12절](./REQUIREMENTS.md), [DATABASE 5절](./DATABASE.md) |

### P3-5. 스태프 급여·근무일정과 전자계약

| 필드 | 내용 |
|---|---|
| 우선순위 | P3 |
| 현재 상태 | **확인 필요** |
| 근거 파일 | `schema.sql`; `staff_salaries`, `staff_schedules`, `schedule_memos`, `contract_templates`, `terms`, `contracts`, 관련 `permissions` |
| 완료 조건 | 급여·일정·계약의 법적·제품 범위와 접근 권한을 결정함. 포함 시 감사 이력·서명·개인정보 보호를 포함한 전체 흐름을 구현하고, 제외 시 스키마 처리 방침을 승인받음 |
| 관련 문서 | [REQUIREMENTS 6-3, 12절](./REQUIREMENTS.md), [DATABASE 5절](./DATABASE.md) |

### P3-6. 알림 규칙·발송 로그, 상담 채널, 스케줄 템플릿

| 필드 | 내용 |
|---|---|
| 우선순위 | P3 |
| 현재 상태 | **확인 필요** |
| 근거 파일 | `schema.sql`, `reservation_functions.sql`; `notification_rules`, `notification_logs`, `messages`, `center_contacts`, `schedule_templates` |
| 완료 조건 | 현재 알림·센터 정보·`CopyCalendar`와 각 객체의 역할을 비교해 중복 여부를 결정함. 사용할 경우 화면·처리 흐름을 연결하고, 사용하지 않을 경우 운영 데이터 확인 후 정리 계획을 승인받음 |
| 관련 문서 | [DATABASE 5절](./DATABASE.md), [REQUIREMENTS 12절](./REQUIREMENTS.md) |

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
| 관련 문서 | [DATABASE 6절](./DATABASE.md) |

### P3-9. 구버전 가능성이 있는 `chat_messages`와 `reviews`

| 필드 | 내용 |
|---|---|
| 우선순위 | P3 |
| 현재 상태 | **확인 필요** |
| 근거 파일 | `schema.sql`, `fix_center_reviews.sql`, `lib/inquiries.ts`, `lib/reviews.ts`; 현재 앱은 `inquiry_messages`, `center_reviews` 사용 |
| 완료 조건 | 운영 row, RPC·trigger·외부 접근을 확인해 대체 완료 여부를 확정함. 데이터 migration·보관·삭제 계획을 사용자 승인 후 수행함 |
| 관련 문서 | [DATABASE 6절, 10-3](./DATABASE.md), [REQUIREMENTS 6-3](./REQUIREMENTS.md) |

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
