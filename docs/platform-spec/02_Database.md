# Database

Status: Active Inventory with Target Notes
Version: 1.1.0
Current-State Source: `schema.sql`, incremental `*.sql`, `lib/*.ts` table/RPC usage
Target-State Status: Migration consolidation and operational verification required
Last Updated: 2026-07-31

## 1. Evidence Rule

저장소 SQL은 의도된 스키마의 근거다. 운영 Supabase에 적용됐다는 증거는 아니므로 적용 여부가 필요한 항목은 Blocked로 분류한다. 앱에서 직접 사용되는 테이블/RPC는 코드와 SQL을 함께 확인한다.

## 2. Current Core Model

### Identity and people

| Official term | Table | Meaning |
|---|---|---|
| Auth User | Supabase `auth.users` | Supabase Auth가 관리하는 인증 주체 |
| Account | `accounts` | 앱 로그인/권한 단위, `auth_id`로 Auth User 연결 |
| Profile | `profiles` | 실제 수강·예약 주체. 한 Account에 여러 개 |
| Platform Admin | `accounts.is_platform_admin` | 플랫폼 운영 권한 |

자체 `users`, `password_credentials`, `sessions`, `devices` 테이블은 현재 핵심 스키마가 아니다.

### Centers and staff authorization

| Table | Current meaning |
|---|---|
| `centers` | 센터 테넌트/운영 단위 |
| `manager_centers` | Account의 센터 운영 소속 |
| `center_roles` | owner/manager/trainer 기본 역할과 센터별 커스텀 역할 |
| `permissions` | 권한 키 카탈로그 |
| `role_permissions` | 역할별 권한 |
| `account_center_permissions` | 개인별 allow/deny 예외 |
| `center_members` | 센터 회원 관리 상태/등급 관계 |

조직 관계의 공식 용어는 **Center Staff Assignment (`manager_centers`)**다. `memberships`라고 부르지 않는다.

### Classes, reservations, passes

| Table | Current meaning |
|---|---|
| `classes` | 센터가 개설한 수업 스케줄 |
| `class_types` | 센터별 수업 구분 |
| `rooms` | 수업 공간 |
| `reservations` | 프로필의 수업 예약/대기/출석/노쇼 |
| `memberships` | 회원이 보유한 수강권/패스 |
| `membership_schedule_rules` | 상품별 예약 가능 요일·시간·수업 규칙 |
| `class_allowed_products` | 수업에서 사용할 수 있는 상품 |
| `admin_action_logs` | 관리자 배치·취소 작업 로그 |

`reservations.reservation_type`의 현재 공식 값은 `MEMBER`, `ADMIN_ASSIGNMENT`, `ADMIN_FREE`다. 기본 스키마 이후 `add_admin_assignment.sql`로 확장되므로 운영 적용 여부는 별도 확인해야 한다.

### Commerce

| Table/module | Current meaning |
|---|---|
| `products` | 판매 항목. `product_kind = pass | goods` |
| `memberships` | pass 상품 발급 결과 |
| `product_passes` | goods 보유/사용권 구조 |
| `cart_items` | 장바구니 |
| `orders` | 회원 주문 및 처리 상태 |
| `payments` | 센터 매출/결제 원장 |
| `lib/payments/*` | Payment Adapter, Mock 구현, Toss/PortOne 골격 |

## 3. Current RPC Boundary

코드에서 확인된 주요 RPC:

- 예약: `reserve_class`, `reserve_with_membership`, `reserve_class_with_goods`, `cancel_reservation`
- 관리자 배치: `admin_assign_reservation`, `admin_cancel_reservation`, `manager_book_member`
- 출석/자동예약: `manager_set_attendance`, `auto_book_membership`, `unplaced_weekday_passes`
- 주문/결제: `fulfill_order`, `confirm_test_payment`, `cancel_test_payment`, `refund_membership`
- 알림/문의/후기: `mark_notifications_read`, `create_announcement`, `open_inquiry_thread`, `send_inquiry_message`, `reply_review`

RPC는 브라우저 요청을 신뢰하지 않고 Auth user, 센터 소속, permission, 상태와 제약을 내부에서 다시 확인해야 한다.

## 4. Current Constraints

- `accounts.auth_id` unique
- `profiles.account_id`로 복수 프로필
- 센터별 역할명 unique
- 개인 permission exception unique `(manager_center_id, permission_key)`
- 수강권 잔여 횟수 음수 금지
- 활성 예약 중복 방지 `(class_id, profile_id)` partial unique index
- 예약 상태와 수강권 상태는 DB check 제약 사용
- 직접배치/무료배치의 타입·source·사유·작업 로그는 확장 SQL에서 관리

## 5. Gap

- 누적 SQL 파일과 `schema.sql` 사이의 최종 운영 스키마 일치가 자동 검증되지 않는다.
- 일부 테이블은 SQL에 있으나 앱 사용 경로가 확인되지 않는다.
- 결제/포인트 관련 구조가 여러 시기에 확장되어 단일 원장 규칙 검증이 필요하다.
- FK, cascade, RLS, function security definer/search_path를 전체 스키마 기준으로 재감사해야 한다.
- 센터 timezone 컬럼과 앱의 KST 고정 변환 간 정합성 결정이 필요하다.

## 6. Target State

- 순서가 보장된 Supabase migration 디렉터리와 재현 가능한 fresh DB
- 생성된 TypeScript DB 타입
- RLS/RPC 권한 테스트와 운영 적용 migration 추적
- 외부 결제 이벤트의 idempotency와 webhook event 저장
- 개인정보 보존·삭제·익명화 정책
- 필요 시 보안 이벤트/세션 metadata 구조. 현재 없는 `sessions/devices`를 선제적으로 만들지 않는다.

## 7. Decision Required / Blocked

| Type | Item |
|---|---|
| Decision Required | `memberships`의 사용자 표기 공식 명칭: 수강권 또는 이용권 |
| Decision Required | `product_passes`와 `memberships`의 장기 통합 여부 |
| Decision Required | 결제 원장과 포인트 원장의 단일 기준 |
| Decision Required | 센터 timezone 일반화 |
| Blocked | 운영 Supabase에 적용된 실제 migration 목록 |
| Blocked | 운영 RLS/Realtime/Storage policy 상태 |

상세 용어는 [Terminology Map](./11_Terminology_Map.md)을 따른다.

