# DATABASE

> `schema.sql`, `reservation_functions.sql`, `add_*.sql`, `fix_*.sql` 분석 기준.
> 이 프로젝트는 별도 API 서버 없이 프론트엔드(`lib/*.ts`)가 Supabase(Postgres)에 직접 접속하므로
> **RLS(Row Level Security)가 사실상 유일한 접근 통제 계층**입니다.
>
> **⚠ 표시 기준**: 아래 표에서 `⚠ 앱 코드 미사용(확인 필요)`가 붙은 테이블은
> `lib/*.ts` 전체에서 `.from("테이블명")` / `.rpc(...)` 호출을 검색했을 때 **한 건도 참조되지 않은 테이블**입니다
> (검증: `grep -rlE 'from\(.<table>.\)' lib/*.ts`, 2026-07-28 기준). schema.sql 주석상 "2차/3차 확장 기능"으로 설계되었으나
> 아직 화면이 만들어지지 않았거나, 다른 테이블로 대체되어 죽은 스키마로 남았을 가능성이 있습니다.
> 이 표시가 없는 테이블은 최소 한 곳 이상의 `lib/*.ts`에서 실제로 조회/변경되는 것을 확인했습니다.

## 1. Supabase 테이블 개요

### 1-1. 계정/권한 계층
| 테이블 | 설명 |
|---|---|
| `accounts` | 로그인 단위(1 로그인 = 1행). `is_member`/`is_manager`/`is_platform_admin` 플래그로 역할 구분 |
| `profiles` | 회원 역할 안에서 실제로 수업을 듣는 주체. 계정 1개가 프로필 여러 개(가족 등) 소유 가능 |
| `center_roles` | 센터별 관리자 역할(오너/매니저/강사 + 커스텀) |
| `permissions` | 권한 카탈로그(고정 데이터, 화면이 이 표를 읽어 자동 렌더링) |
| `role_permissions` | 역할별 부여된 권한 |
| `account_center_permissions` | 개인별 권한 오버라이드(allow/deny) |
| `manager_centers` | 계정이 운영/근무하는 센터 + 그 센터에서의 역할, 승인 상태(pending/active/suspended) |

### 1-2. 센터/수업
| 테이블 | 설명 |
|---|---|
| `centers` | 센터(시설) 기본정보, 승인 상태(pending/approved/rejected), 결제수단, 위치 |
| `center_settings` | 센터별 예약/취소/폐강/대기 등 17개 운영 규칙(1 센터 = 1행) |
| `center_holidays` | 센터 휴무일 |
| `rooms` | 수업이 열리는 공간 |
| `lockers` / `locker_assignments` | ⚠ 앱 코드 미사용(확인 필요). `center_settings.use_locker` 토글만 존재하고 락커 배정 UI/데이터 함수는 없음 |
| `class_types` | ⚠ 앱 코드 미사용(확인 필요). `classes.class_type_id` 컬럼이 있으나 `lib/classes.ts`에서 참조하지 않음 |
| `classes` | 실제 수업 스케줄(그룹/프라이빗, 정원, 마감시간, 반복그룹 id) |
| `class_trainers` | ⚠ 앱 코드 미사용(확인 필요). schema.sql 주석은 "수업별 복수 강사 배정"이라 설명하지만, 현재 `lib/classes.ts`에는 강사 배정 로직이 없음. 매출 귀속용 단일 강사(`payments.trainer_account_id`)만 실제 사용 중 |
| `class_allowed_products` | 수업별 예약 가능한 수강권 제한 |

### 1-3. 수강권/결제
| 테이블 | 설명 |
|---|---|
| `products` | 판매 상품(수강권/굿즈) 정의 — 실제 사용 |
| `product_passes` | ⚠ 앱 코드 미사용(확인 필요) |
| `memberships` | 회원이 보유한 수강권(횟수권/기간권), 잔여횟수는 음수 불가 제약 |
| `membership_schedule_rules` | 수강권별 예약 가능 요일/시간/수업명 조건 |
| `membership_transfers` | ⚠ 앱 코드 미사용(확인 필요). 스키마 주석상 "프로필 간 수강권 양도 이력"이지만 `lib/*.ts`에서 조회/기록 코드를 찾지 못함 — 양도 이력이 실제로 남는지 재확인 필요 |
| `payments` | 매출 원장(분할결제, 미수금, 위약금, 매출구분) |
| `expenses` | 지출 내역 |
| `point_transactions` | 매출 화면(`/manager/sales`)에서 사용하는 포인트 적립/사용 원장 — 실제 사용 |
| `point_accounts` | 후기 작성 시 포인트 잔액 조회/차감(`lib/reviews.ts`)에 사용 — 실제 사용 |
| `point_logs` | ⚠ 앱 코드 미사용(확인 필요) |
| `orders` | 회원 구매 주문(pending → paid/done/cancelled), 실제 PG 연동 없이 매니저가 수동 처리 |
| `cart_items` | 장바구니 |
| `purchase_requests` | 센터 상품 구매 신청 |

> **⚠ 확인 필요 — 포인트 시스템 이중화**: `point_transactions`(매출/결제 화면)와 `point_accounts`(후기 화면)가
> 서로 다른 `lib` 파일에서 각각 별도로 사용되고 있습니다. 두 테이블이 하나의 포인트 잔액을 함께 관리하는 구조인지,
> 아니면 서로 다른 시점에 만들어진 별개의(중복된) 포인트 시스템인지 코드만으로는 판단할 수 없습니다.
> 회원이 실제로 보는 "포인트 잔액"이 어느 쪽 테이블을 기준으로 계산되는지 반드시 확인 후 문서를 갱신하세요.

### 1-4. 예약
| 테이블 | 설명 |
|---|---|
| `reservations` | 예약/취소/대기 내역. `(class_id, profile_id)` 유니크(활성 상태 한정)로 중복예약 방지 |

### 1-5. 회원 관리
| 테이블 | 설명 |
|---|---|
| `center_members` | 센터별 회원(등급/상태), `member_grades`와 연동 |
| `member_grades` | 회원 등급 정의 |
| `member_center_colors` | 회원별 캘린더 색상 |
| `center_member_fields` / `profile_center_fields` | ⚠ 앱 코드 미사용(확인 필요). 스키마 주석상 "센터별 커스텀 회원 필드" |
| `leads` | ⚠ 앱 코드 미사용(확인 필요). `permissions` 카탈로그에 `customer.lead.*` 권한은 정의되어 있으나 실제 CRUD 화면 없음 |
| `change_logs` | ⚠ 앱 코드 미사용(확인 필요) |

### 1-6. 커뮤니케이션
| 테이블 | 설명 |
|---|---|
| `chat_messages` | ⚠ 앱 코드 미사용(확인 필요). schema.sql 주석상 "구버전"으로 보이며, 1:1 문의는 아래 `inquiry_messages`로 대체된 것으로 추정 |
| `inquiry_threads` / `inquiry_messages` | 1:1 문의 채팅 — 실제 사용 |
| `notifications` | 회원/매니저 알림함 (Realtime publication 필요) — 실제 사용 |
| `notification_rules` / `notification_logs` | ⚠ 앱 코드 미사용(확인 필요) |
| `messages` | ⚠ 앱 코드 미사용(확인 필요). 스키마 주석상 "SMS/푸시 메시지 발송 기록"이지만, [REQUIREMENTS.md](./REQUIREMENTS.md)에서 확인했듯 실제 발송 연동이 없어 이 테이블도 아직 쓰이지 않는 것으로 보임 |
| `popup_notices` | ⚠ 앱 코드 미사용(확인 필요) |
| `center_announcements` | 매니저 공지사항 — 실제 사용 |

### 1-7. 후기/커뮤니티/기타
| 테이블 | 설명 |
|---|---|
| `reviews` | ⚠ 앱 코드 미사용(확인 필요/사실상 폐기). `fix_center_reviews.sql` 주석에 "⚠ 센터 후기 테이블 분리(오류 수정)"라고 명시되어 있고, 실제 코드(`lib/reviews.ts`)는 전부 `center_reviews`만 사용함 |
| `center_reviews` | 센터 후기 — 실제 사용 |
| `community_posts` / `community_comments` | ⚠ 앱 코드 미사용(확인 필요) |
| `competitions` | ⚠ 앱 코드 미사용(확인 필요) |
| `progress_categories` / `progress_records` | 진도표 기술 카테고리 및 회원별 기록 — 실제 사용 |
| `staff_salaries` / `staff_schedules` / `schedule_memos` | ⚠ 앱 코드 미사용(확인 필요). `permissions` 카탈로그에 급여 관련 권한(`facility.salary.*`)은 정의되어 있으나 실제 화면 없음 |
| `contract_templates` / `terms` / `contracts` | ⚠ 앱 코드 미사용(확인 필요). `permissions` 카탈로그에 `contract.*` 권한은 정의되어 있으나 실제 화면 없음 |
| `service_categories` | 홈 화면 종목(카테고리) 필터 — 실제 사용 |
| `home_banners` | 홈 배너 — 실제 사용 |
| `center_contacts` | ⚠ 앱 코드 미사용(확인 필요) |
| `schedule_templates` | ⚠ 앱 코드 미사용(확인 필요) |

### 1-8. 검증 결과 요약: 스키마에는 있으나 앱 코드에서 확인되지 않은 테이블
아래 27개 테이블은 `lib/*.ts` 전체에서 `.from()` 참조를 찾지 못했습니다. 권한 카탈로그(`permissions`)에는
관련 권한 키가 이미 정의된 경우가 있어(급여/계약서/상담고객 등) **기능 자체가 로드맵에는 있고 화면만 아직 없는 것**으로 보이는 항목과,
`chat_messages`/`reviews`처럼 **다른 테이블로 대체되어 죽은 스키마로 남은 것**으로 보이는 항목이 섞여 있습니다.
이 구분은 코드만으로는 확정할 수 없으므로, 실제로 사용 계획이 없다면 정리하고 문서에도 반영하는 것을 권장합니다.

```
class_types, lockers, locker_assignments, class_trainers, product_passes,
membership_transfers, point_logs, center_member_fields, profile_center_fields,
leads, change_logs, chat_messages, notification_rules, notification_logs, messages,
popup_notices, reviews(구), community_posts, community_comments, competitions,
staff_salaries, staff_schedules, schedule_memos, contract_templates, terms, contracts,
center_contacts, schedule_templates
```

> 검증 방법의 한계: 이 검사는 `.from("테이블명")` 형태의 직접 호출만 잡아냅니다. Supabase의 중첩 select
> (`.select("*, 다른테이블(...)")`) 구문으로만 참조되는 경우는 놓칠 수 있으므로, 위 목록에서 실제로 삭제/변경 작업을
> 진행하기 전에는 반드시 해당 테이블명을 코드 전체(주석 포함)에서 다시 한번 검색해 재확인하세요.

> ※ 정확한 컬럼 목록은 `schema.sql` 및 각 `add_*.sql`을 원본으로 참조하세요. 이 문서는 요약이며,
> 일부 컬럼은 이후 마이그레이션에서 추가/변경되었을 수 있습니다(예: `rooms`는 `add_rooms.sql` → `add_rooms_fix.sql`로 컬럼 보강).

## 2. 주요 테이블 핵심 컬럼

### `accounts`
`id`, `auth_id`(Supabase Auth 연결, unique), `name`, `phone`(unique), `is_member`, `is_manager`, `is_platform_admin`

### `profiles`
`id`, `account_id` → `accounts`, `name`, `label`, `birth_date`, `cloth_size`, `address`, `is_primary`

### `classes`
`id`, `center_id` → `centers`, `title`, `class_format`(`group`/`private`), `class_type_id`, `room_id`, `start_time`, `end_time`, `min_capacity`, `capacity`, `booking_deadline_min`, `cancel_deadline_min`, `autocancel_deadline_min`, `waitlist_deadline_min`, `status`(`open`/`closed`/`cancelled`), `recurring_group_id`

### `memberships`
`id`, `profile_id` → `profiles`, `center_id` → `centers`, `product_id`, `pass_type`(`count`/`period`), `total_count`, `remaining_count`(음수 불가 CHECK), `starts_at`, `expires_at`, `auto_renew`, `paused_from/until`, `allow_multi_booking`, `status`(`active`/`expired`/`paused`/`refunded`/`transferred`)

### `reservations`
`id`, `class_id` → `classes`, `profile_id` → `profiles`, `membership_id` → `memberships`, `status`(`confirmed`/`waitlisted`/`cancelled`/`attended`/`no_show`), `waitlist_order`, `member_memo`

### `payments`
`id`, `profile_id`, `center_id`, `membership_id`, `sale_type`(`new`/`renew`/`trial`/`upgrade`/`refund`/`unpaid_pay`/`transfer_fee`), `revenue_category`(`membership`/`class`/`etc`), `card_amount`/`cash_amount`/`transfer_amount`/`point_amount`/`total_amount`/`unpaid_amount`/`penalty_amount`, `status`(`pending`/`paid`/`refunded`/`failed`)

### `manager_centers`
`id`, `account_id` → `accounts`, `center_id` → `centers`, `role_id` → `center_roles`, `specialty`, `status`(`pending`/`active`/`suspended`)

## 3. 테이블 관계 (요약 ERD, 실제 사용 중인 테이블만)

```
accounts 1─┬─* profiles ──* memberships ──* reservations *──1 classes
           │                                    │                │
           │                                    │                └─1 rooms
           │                                    └─* payments        └─* center_id → centers
           └─* manager_centers *──1 centers 1──* center_settings / center_holidays / rooms
                    │                              1──* products / member_grades
                    └─1 center_roles ──* role_permissions ──* permissions
                    └─* account_center_permissions (개인별 권한 오버라이드)

centers 1──* memberships / payments / orders / center_announcements / notifications(대상)
profiles 1──* point_transactions, progress_records
inquiry_threads 1──* inquiry_messages
```

핵심 축은 **`accounts → profiles`(회원 축)**와 **`accounts → manager_centers → centers`(운영 축)**이며,
`profiles`가 예약·수강권·진도·포인트 등 회원측 데이터의 실제 소유자입니다.

> 위 다이어그램은 1-8절에서 "⚠ 앱 코드 미사용"으로 표시한 테이블(`class_trainers`, `class_types`,
> `membership_transfers` 등)을 의도적으로 제외했습니다. FK 자체는 스키마에 존재하므로, 실제 참조 무결성
> 관계는 `schema.sql`을 원본으로 확인하세요.

## 4. RLS 정책 확인 사항

- 헬퍼 함수 3종이 모든 정책의 기반입니다 (`schema.sql` "14. 보안 설정" 섹션):
  - `my_account_id()` — 현재 로그인 계정의 `accounts.id`
  - `my_profile_ids()` — 현재 계정이 소유한 `profiles.id` 목록
  - `is_platform_admin()` — 현재 계정의 플랫폼 운영자 여부
  - 세 함수 모두 `security definer`로 선언되어 있음 — 정책 안에서 호출 시 대상 테이블 RLS를 다시 타지 않기 위함(무한 재귀 방지). **새 헬퍼 함수 추가 시 이 패턴을 유지해야 함.**
- `schema.sql`에서 RLS가 켜진 테이블: `accounts`, `profiles`, `manager_centers`, `memberships`, `reservations`, `chat_messages`, `community_posts`, `reviews` (8개). 이후 `add_*.sql`에서 새로 만든 테이블(`notifications`, `inquiry_threads`, `center_announcements`, `orders`, `cart_items` 등)도 각 파일에서 개별적으로 RLS를 켜고 정책을 추가함 — **신규 테이블 추가 시 RLS 활성화를 빠뜨리지 않도록 주의**.
- 정책 개수가 많은 파일(=RLS가 자주 수정된 영역, 신중히 다뤄야 함):
  - `reservation_functions.sql` — 96개 (예약 전체 흐름)
  - `fix_rls_policies.sql` — 13개 ("긴급 패치: RLS 정책에 with check 누락 수정")
  - `schema.sql` — 13개 (기본 정책)
  - `add_member_management.sql` — 12개
  - `add_sales.sql` — 10개
  - `add_staff_permissions.sql` — 9개
- **RLS 관련 버그 수정 이력이 많음** — 아래 `fix_*.sql`은 모두 RLS 회귀 버그를 고친 것이므로, 관련 테이블(`profiles`, `memberships`, `reservations`, `accounts`, `reviews`)을 건드릴 때 반드시 참고:
  - `fix_profile_rls_restore.sql` — "긴급 복구: 프로필을 찾을 수 없어요 오류"
  - `fix_rls_policies.sql` — `with check` 누락 수정
  - `fix_membership_rls.sql` — 수강권 발급/회원 추가 RLS 수정
  - `fix_staff_search.sql` — `accounts` 조회 정책의 무한 재귀 해결
  - `add_roster_rls.sql` — 예약자 명단 미노출 문제
  - `fix_member_status.sql` — 회원 만료/휴면 처리 권한
- `centers.status = 'pending'`인 센터는 일반 회원에게 노출되지 않아야 함 — 관련 SELECT 정책이 있는지 변경 시 확인.
- `is_platform_admin`은 가입 절차로는 절대 true가 될 수 없고 DB에서 직접 부여함(`add_platform_admin.sql`) — 코드에서 self-service로 승격시키는 경로를 추가하면 안 됨.

## 5. 사용 중인 SQL 파일 목록 (실행 순서 기준)

`README.md`가 명시하는 필수 순서: ① `schema.sql` → ② `reservation_functions.sql` → ③ 이후 `add_*.sql`/`fix_*.sql` (일부는 서로 의존하므로 아래 표의 "의존" 열 참고).

| 파일 | 목적 |
|---|---|
| `schema.sql` | 기본 테이블/RLS/헬퍼 함수 (최초 1회, 필수) |
| `reservation_functions.sql` | 예약 처리 함수 + 관련 RLS (필수, schema.sql 다음) |
| `auth_policies.sql` | 회원가입 시 INSERT를 여는 RLS (로그인 동작에 필수) |
| `add_account_address.sql` | 회원 주소(검색·관리용) |
| `add_announcements.sql` | 센터 공지사항 |
| `add_attendance.sql` | 매니저 출결 처리 RPC |
| `add_auto_booking.sql` | 요일반 수강권 자동예약 |
| `add_center_category.sql` | 센터 종목(카테고리) — 홈 필터용 |
| `add_center_intro.sql` | 센터 상세 소개글 컬럼 |
| `add_center_location.sql` | 센터 위치 좌표 |
| `add_center_media.sql` | 센터 프로필 사진 + SNS |
| `add_center_settings.sql` | 운영 설정 기능(`center_settings` RLS) |
| `add_center_shop.sql` | 구매 신청 + 상품/수강권 판매 |
| `add_class_goods_option.sql` | 수업 상품 사용 옵션 + 예약 시 상품 차감 |
| `add_class_products.sql` | 수강권/상품 체계 개편 + 수업별 예약가능 수강권 |
| `add_direct_payment.sql` | 매출 직접결제 항목 |
| `add_holiday_sync.sql` | 휴무일 연동(수업 자동 삭제 + 예약자 처리) |
| `add_inquiries.sql` | 1:1 문의(회원 ↔ 센터 채팅), 마지막 실행 권장 순서 4단계 |
| `add_intro_blocks.sql` | 센터 소개 블로그식(사진+글) |
| `add_makeup_booking.sql` | 관리자 보강 예약 |
| `add_member_dormant.sql` | 휴면회원 - 기간권 차감 정지 |
| `add_member_management.sql` | 회원관리 기능(RLS 정책 다수) |
| `add_membership_rules.sql` | 수강권 예약조건(상품 단위) 실연동 |
| `add_new_permissions.sql` | 새 기능 권한 추가 |
| `add_notification_triggers.sql` | 예약 관련 알림 트리거 |
| `add_notifications.sql` | 알림 시스템(회원+매니저), 실행 순서 2단계 |
| `add_operator_settings.sql` | 운영자 설정: 종목/홈 배너/센터 종목(다중) |
| `add_order_fulfillment.sql` | 주문 발급 자동화(수강권 자동 추가 + 매출 연동) |
| `add_orders.sql` | 주문/결제 `orders` 테이블 |
| `add_pass_binding.sql` | 수강권/상품 프로필 귀속(사용 시점 확정) |
| `add_pay_methods.sql` | 센터별 결제수단 지정 |
| `add_personal_permissions.sql` | 개인별 권한 예외 |
| `add_platform_admin.sql` | 플랫폼 운영자(센터 승인 담당) 추가 |
| `add_product_extras.sql` | 상품 상세설명 + 대여 사이즈 + 장바구니 |
| `add_profile_extras.sql` | 프로필 추가 정보(옷 사이즈/주소) |
| `add_profile_fields.sql` | 프로필 선택 정보 + 사진 |
| `add_progress_categories.sql` | 진도표 1단계: 기술 목록 관리 |
| `add_recurring_group.sql` | 반복수업 그룹 관리 |
| `add_refund_and_membership.sql` | 환불 + 회원 자동 등록/복귀 |
| `add_reservation_memo.sql` | 회원 예약 개인 메모 |
| `add_review_reply.sql` | 후기 관리(센터 답변 + 관리자 삭제) |
| `add_reviews_points.sql` | 센터 후기 + 포인트 |
| `add_rooms.sql` → `add_rooms_fix.sql` | 룸(장소) 시스템 → 컬럼 보강 |
| `add_roster_rls.sql` | 예약자 명단 미노출 문제(RLS) |
| `add_sales.sql` | 매출 관리 기능 |
| `add_same_day_setting.sql` | 운영설정: 당일 예약 가능 여부 |
| `add_shared_passes.sql` | 프로필 간 수강권 공유 |
| `add_staff_permissions.sql` | 스태프 & 권한 관리 |
| `add_unplaced_passes.sql` | 요일반 수강권: 미배치 잔여 횟수 관리 |
| `fix_auto_book_oneperday.sql` | 요일반 자동예약: 하루 최대 1개 제한 |
| `fix_center_reviews.sql` | 센터 후기 테이블 분리(오류 수정) |
| `fix_class_delete.sql` | 수업 삭제 안전 함수 |
| `fix_member_status.sql` | 회원 만료/휴면 처리 권한 |
| `fix_membership_rls.sql` | 수강권 발급 + 회원 추가 RLS 수정 |
| `fix_missing_primary_profile.sql` | 대표 프로필 없음/중복 계정 복구 |
| `fix_profile_rls_restore.sql` | 긴급 복구: 프로필 조회 오류 |
| `fix_rls_policies.sql` | RLS `with check` 누락 긴급 패치 |
| `fix_staff_search.sql` | 스태프 검색 복구(무한 재귀 해결) |
| `fix_waitlist.sql` | 대기자 자동 승격 수정(v2) |
| `setup_storage.sql` | 사업자등록증 Storage 버킷 설정 |
| `wire_settings.sql` | 운영 설정 → 예약/취소 규칙 실제 연동 |

### 5-1. 운영/유지보수용 (스키마 변경 아님)
| 파일 | 목적 |
|---|---|
| `diagnose_profile.sql` | "프로필을 찾을 수 없어요" 진단 쿼리 |
| `reset_class_products.sql` | 수업-수강권 연결 + 예약조건 초기화 |
| `reset_test_data.sql` | 테스트 데이터 전체 삭제(센터/수업/수강권/예약) |
| `seed_data.sql` | 테스트용 시드 데이터 |

> **주의**: `reset_test_data.sql`은 파괴적 스크립트입니다. 운영 DB에서 실행 금지.
