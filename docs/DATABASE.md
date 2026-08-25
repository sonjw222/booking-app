# DATABASE

## 1. 문서 메타데이터

| 항목 | 값 |
|---|---|
| 문서 목적 | Supabase 데이터 구조, 보호 경계, 앱에서 사용하는 RPC·트리거와 SQL 원본의 기준선 |
| 최종 검증일 | 2026-07-28 |
| 검증 대상 | `app/`, `lib/`, `schema.sql`, `reservation_functions.sql`, 루트 `add_*.sql`·`fix_*.sql` |
| 코드 사용 판정 | `app/`·`lib/`의 `.from("...")`, `.rpc("...")`, 중첩 select와 관련 SQL 정의를 직접 검색 |
| 한계 | 운영 Supabase에 실제 적용된 migration 순서·함수 본문·RLS·트리거 활성 상태는 저장소만으로 확인할 수 없음 |
| 관련 문서 | [요구사항과 상태 기준](./REQUIREMENTS.md) · [라우트와 접근 통제](./ROUTES.md) · [후속 작업](./TODO.md) |

## 2. 문서의 역할과 상태 표현

이 문서는 제품 기능 설명보다 데이터 객체의 현재 사용 여부와 보호 조건을 설명합니다. 기능의 구현·미완성·확인 필요 판정은 [REQUIREMENTS.md](./REQUIREMENTS.md)를 기준으로 하며, 여기서는 같은 용어를 다음처럼 적용합니다.

| 상태 | DB 문서에서의 의미 |
|---|---|
| **구현됨** | 앱 코드가 테이블·뷰·RPC를 직접 사용하고 관련 화면 흐름이 연결되어 있음 |
| **미완성** | 일부 DB 객체는 사용하지만 제품 흐름 또는 외부 연동이 완성되지 않음 |
| **확인 필요** | 스키마나 SQL 정의는 있으나 앱 사용 또는 운영 DB 적용 상태를 확인할 수 없음 |
| **운영 설정 필요** | SQL·코드는 존재하지만 Realtime, pg_cron, Auth Provider 등 운영 Supabase 설정이 필요함 |

분류 원칙:

- 테이블이 존재한다는 이유만으로 기능을 **구현됨**으로 판단하지 않습니다.
- “코드 미사용”은 `app/`·`lib/`에서 직접 사용을 확인하지 못했다는 뜻이며, 삭제 가능하다는 뜻이 아닙니다.
- SQL 파일에 정의된 객체가 운영 DB에도 존재한다고 추측하지 않습니다.
- 같은 함수가 여러 SQL 파일에서 재정의되므로 파일명만 보고 운영 중인 최종 본문을 단정하지 않습니다.
- Storage 버킷과 SQL view는 일반 테이블과 분리합니다.

## 3. 데이터 구조 요약

핵심 데이터 축은 두 개입니다.

```text
회원 축: accounts → profiles → memberships → reservations → classes
운영 축: accounts → manager_centers → centers → classes/products/members/orders
```

- `accounts`는 로그인 계정입니다.
- `profiles`는 실제 수강·예약의 주체이며 한 계정이 여러 프로필을 가질 수 있습니다.
- `manager_centers`는 계정과 운영 센터의 소속·역할을 연결합니다.
- `centers`는 수업, 상품, 회원, 주문, 매출과 커뮤니케이션 데이터의 중심입니다.
- 브라우저가 Supabase를 직접 호출하므로 RLS와 RPC가 최종 서버 측 보호 계층입니다.

## 4. 현재 앱에서 사용 중인 데이터 객체

아래 표는 `app/`·`lib/`의 직접 호출과 화면 연결을 확인한 객체입니다.

### 4-1. 계정과 권한

| 테이블 | 상태 | 현재 역할 |
|---|---|---|
| `accounts` | 구현됨 | Supabase Auth와 연결되는 로그인 계정, 회원·매니저·플랫폼 운영자 플래그 |
| `profiles` | 구현됨 | 예약·수강권·진도·포인트의 회원 주체 |
| `manager_centers` | 구현됨 | 계정의 센터 소속, 역할, 활성 상태 |
| `center_roles` | 구현됨 | 오너·매니저·강사·커스텀 역할 |
| `permissions` | 구현됨 | 권한 카탈로그 |
| `role_permissions` | 구현됨 | 역할별 권한 |
| `account_center_permissions` | 구현됨 | 개인별 권한 allow/deny 예외 |

### 4-2. 센터, 수업과 예약

| 테이블 | 상태 | 현재 역할 |
|---|---|---|
| `centers` | 구현됨 | 센터 기본정보, 승인 상태, 위치, 결제수단 |
| `center_settings` | 구현됨 | 예약·취소·폐강·대기·당일 예약 등 운영 규칙 |
| `center_holidays` | 구현됨 | 센터 휴무일 |
| `rooms` | 구현됨 | 수업 공간 |
| `classes` | 구현됨(그룹) / MVP(프라이빗) | 반복그룹, 정원, 마감, 상태. 프라이빗은 2026-08-03 QA 배치(CLASS-001)에서 관리자 UI 선택 + 정원 1명 강제(CHECK)까지만 구현 — 지정회원전용 접근 제한은 아직 미구현(제품 결정 필요) |
| `class_allowed_products` | 구현됨 | 수업별 예약 가능한 수강권 상품 |
| `reservations` | 구현됨 | 예약·대기·취소·출석·노쇼 및 개인 메모. `reservation_type`(MEMBER/ADMIN_ASSIGNMENT/ADMIN_FREE), `reservation_source`(USER/ADMIN/SYSTEM), `admin_reason_code`/`admin_reason_detail`, `is_capacity_override`, `membership_consumed`, `cancelled_by`/`cancel_reason`/`cancelled_at`, `created_by_account_id`, `updated_at` 추가(`add_admin_assignment.sql`) |
| `admin_action_logs` | 구현됨 | 관리자 직접배치/무료배치/취소 작업 로그 (append-only, 일반 매니저 UI에서 수정·삭제 불가). `add_admin_assignment.sql` |

### 4-3. 상품, 수강권, 주문과 매출

| 테이블 | 상태 | 현재 역할 |
|---|---|---|
| `products` | 구현됨 | 수강권·굿즈 상품 정의 |
| `membership_schedule_rules` | 구현됨 | 수강권 상품의 요일·시간·수업명 사용 조건 |
| `memberships` | 구현됨 | 프로필이 보유한 횟수권·기간권, 잔여횟수와 상태 |
| `cart_items` | 구현됨 | 회원 장바구니 |
| `orders` | 미완성 | 주문 접수와 매니저 발급 처리. 실제 PG 결제는 연결되지 않음 |
| `purchase_requests` | 확인 필요 | `lib/center.ts`에 insert helper가 있으나 현재 `app/center/[id]/page.tsx`는 장바구니를 사용하며 helper 호출은 확인되지 않음 |
| `payments` | 구현됨 | 매출 원장, 분할결제, 미수금, 위약금, 결제 담당 강사 |
| `expenses` | 구현됨 | 센터 지출 |
| `point_transactions` | 구현됨 | 매니저 매출 화면의 포인트 적립·사용 원장 |
| `point_accounts` | 구현됨 / 확인 필요 | 후기와 회원 구매 흐름의 포인트 잔액. `point_transactions`와 통합되는지는 확인 필요 |

`point_transactions`와 `point_accounts`는 앱에서 각각 사용되지만 두 체계가 하나의 잔액으로 동기화되는 SQL 관계는 확인하지 못했습니다. 포인트 통합 여부는 **확인 필요**입니다.

### 4-4. 회원과 진도

| 테이블 | 상태 | 현재 역할 |
|---|---|---|
| `center_members` | 구현됨 | 센터별 회원 상태·등급 |
| `member_grades` | 구현됨 | 센터 회원 등급 |
| `member_center_colors` | 구현됨 | 프로필별 센터 캘린더 색상 |
| `progress_categories` | 구현됨 | 진도 기술 카테고리 |
| `progress_records` | 구현됨 | 회원별 진도 기록 |

### 4-5. 후기, 공지, 알림과 문의

| 테이블 | 상태 | 현재 역할 |
|---|---|---|
| `center_reviews` | 구현됨 | 현재 앱이 사용하는 센터 후기 |
| `center_announcements` | 구현됨 | 센터 공지사항 |
| `notifications` | 구현됨 / 운영 설정 필요 | 회원·매니저 알림함과 Realtime 팝업 |
| `inquiry_threads` | 구현됨 / 운영 설정 필요 | 회원-센터 문의방 |
| `inquiry_messages` | 구현됨 / 운영 설정 필요 | 문의 메시지와 Realtime 채팅 |

Realtime publication과 운영 RLS 적용 상태는 저장소에서 확인할 수 없으므로 운영 환경에서 별도 확인해야 합니다.

### 4-6. 플랫폼 노출 설정

| 테이블 | 상태 | 현재 역할 |
|---|---|---|
| `service_categories` | 구현됨 | 홈 종목 필터 |
| `home_banners` | 구현됨 | 홈 배너 |

### 4-7. 테이블이 아닌 사용 객체

| 객체 | 종류 | 상태 | 용도 |
|---|---|---|---|
| `class_reservation_counts` | view | 구현됨 | 수업별 활성 예약 수 집계 |
| `revenue_summary` | view | 확인 필요 | SQL 정의는 있으나 현재 `app/`·`lib/`의 직접 조회는 확인하지 못함 |
| `avatars` | Storage bucket | 구현됨 / 운영 설정 필요 | 프로필·센터·후기 이미지 업로드 |
| `business-licenses` | private Storage bucket | 구현됨 / 운영 설정 필요 | 매니저 가입 사업자등록증 |

Storage 버킷의 운영 생성 여부와 정책 적용 상태는 Supabase에서 **확인 필요**입니다. `business-licenses` 설정 원본은 `setup_storage.sql`입니다.

## 5. 향후 기능 후보 테이블

아래 객체는 스키마 주석, 컬럼 또는 권한 카탈로그에서 용도를 확인했지만 앱의 완성된 CRUD 흐름은 찾지 못했습니다. 따라서 기능 상태는 모두 **확인 필요**입니다.

| 기능 후보 | 관련 테이블 | 확인된 근거 | 확인 필요 사항 |
|---|---|---|---|
| 수업 구분 | `class_types` | `classes.class_type_id` FK | 분류 관리 화면과 실제 수업 적용 |
| 수업별 복수 강사 | `class_trainers` | 수업-계정 연결 스키마와 RLS | 배정 CRUD. `payments.trainer_account_id`와는 별개 |
| 락커 | `lockers`, `locker_assignments` | `center_settings.use_locker` 설정 | 락커 관리와 회원 배정 |
| 수강권 양도 | `membership_transfers` | 양도 이력 스키마, `transfer_fee` 매출 구분 | 실제 수강권 재배정과 이력 기록 |
| 회원 커스텀 필드 | `center_member_fields`, `profile_center_fields` | 센터 필드 정의·회원 입력값 스키마와 RLS | 실제 설정·입력 화면 |
| 상담고객 | `leads` | `customer.lead.*` 권한 | 리드 CRUD와 회원 전환 |
| 팝업공지 | `popup_notices` | 팝업 공지 스키마 | 작성·노출 흐름 |
| 대회정보 | `competitions` | 대회 정보 스키마 | 관리·회원 화면 |
| 커뮤니티 | `community_posts`, `community_comments` | 게시글·댓글 스키마 | 앱 화면과 moderation 정책 |
| 스태프 급여·일정 | `staff_salaries`, `staff_schedules`, `schedule_memos` | 급여 관련 권한과 스키마 | 운영 화면과 정산 규칙 |
| 전자계약 | `contract_templates`, `terms`, `contracts` | `contract.*` 권한과 서명 상태 스키마 | 작성·동의·서명 흐름 |
| 알림 규칙·발송 | `notification_rules`, `notification_logs`, `messages` | 예약 알림 규칙과 발송 기록 스키마 | 외부 발송기, 재시도, 로그 기록 |
| 상담 채널 | `center_contacts` | 센터 연락 채널 스키마와 RLS | 현재 센터 정보 필드와의 역할 구분 |
| 스케줄 템플릿 | `schedule_templates` | 템플릿 스키마와 RLS | 현재 `CopyCalendar`와의 역할 구분 |

이 목록은 로드맵 확정을 뜻하지 않습니다. 제품에 포함할지는 [REQUIREMENTS.md 12절](./REQUIREMENTS.md)의 로드맵 원칙에 따라 결정해야 합니다.

## 6. 코드 미사용이며 용도 또는 존속 여부가 불명확한 테이블

아래 객체도 앱 코드에서 직접 사용되지 않지만, 5절과 달리 현재 제품의 향후 기능이라고 단정하기 어렵습니다.

| 테이블 | 상태 | 확인 결과 |
|---|---|---|
| `product_passes` | 확인 필요 | 스키마에는 상품권 소유 구조가 있으나 현재 앱은 `memberships`, `products`를 사용 |
| `point_logs` | 확인 필요 | `point_accounts` 관련 로그로 보이나 앱과 현재 SQL 흐름에서 실제 기록·조회 여부를 확정하지 못함 |
| `change_logs` | 확인 필요 | 변경 이력용 스키마는 있으나 앱 호출과 핵심 트리거를 확인하지 못함 |
| `chat_messages` | 확인 필요 | 현재 1:1 문의는 `inquiry_threads`·`inquiry_messages`를 사용. 구버전 대체 여부는 확인 필요 |
| `reviews` | 확인 필요 | 현재 후기는 `center_reviews`를 사용. `fix_center_reviews.sql` 이후 폐기 대상인지 운영 데이터 확인 필요 |

5절 23개와 이 절 5개를 합친 **28개 테이블**은 `app/`·`lib/`의 직접 `.from()` 사용을 확인하지 못했습니다. 중첩 select, RPC 내부 사용, 운영 외부 도구의 접근은 이 검사만으로 배제할 수 없으므로 삭제 전 전체 SQL과 운영 DB를 다시 확인해야 합니다.

## 7. 보호해야 할 핵심 테이블

“보호해야 함”은 삭제뿐 아니라 컬럼 타입, FK, 상태값, RLS, trigger, RPC 변경 시 다중 역할 회귀 검증이 필요하다는 뜻입니다.

### 7-1. 인증과 권한 경계

| 테이블 | 보호 이유 | 변경 시 필수 확인 |
|---|---|---|
| `accounts` | Auth 사용자와 앱 계정 연결, 플랫폼 운영자 플래그 | 본인 조회·수정, 스태프 검색, 운영자 승격 차단 |
| `profiles` | 모든 회원 데이터의 소유 주체 | 본인 프로필, 대표 프로필, 매니저 회원 조회 |
| `manager_centers` | 센터 운영 권한의 소속 경계 | 오너·매니저·강사 접근과 승인 상태 |
| `center_roles` | 센터 역할 정의 | 오너 전권과 커스텀 역할 |
| `permissions` | 서버 권한 키 카탈로그 | 기존 `has_permission()` 호출 키 |
| `role_permissions` | 역할별 권한 | 역할 변경 후 접근 범위 |
| `account_center_permissions` | 개인별 allow/deny | 역할 권한과 개인 예외의 우선순위 |

### 7-2. 예약과 수강권 상태 전이

| 테이블 | 보호 이유 | 변경 시 필수 확인 |
|---|---|---|
| `classes` | 예약 가능 대상, 정원·마감·폐강 상태 | 공개 조회, 매니저 CRUD, 반복수업 삭제 |
| `reservations` | 예약·대기·출석·노쇼 원장 | 중복예약 인덱스, 대기 승격, 횟수 복구·차감 |
| `memberships` | 수강권 잔여횟수와 유효 상태 | 음수 방지, 공유 프로필 사용, 환불·정지 |
| `class_allowed_products` | 수업에 사용할 수 있는 상품 제한 | 예약 가능 수강권 판정 |
| `membership_schedule_rules` | 요일·시간·수업명 제한 | 자동예약과 수동예약의 동일 판정 |
| `center_settings` | 예약·취소·폐강의 센터별 정책 | `calc_deadline`, `reserve_class`, `cancel_reservation` |

### 7-3. 돈, 주문과 포인트

| 테이블 | 보호 이유 | 변경 시 필수 확인 |
|---|---|---|
| `orders` | 회원 주문과 발급 상태 | `pending`·`paid`·`done`·`cancelled`, 중복 발급 |
| `payments` | 매출 원장과 분할결제 | 합계, 환불, 미수금, 상태 CHECK |
| `memberships` | 주문 처리 결과로 발급되는 자산 | 주문과 수강권의 연결·중복 발급 |
| `point_transactions` | 매니저 포인트 원장 | 적립·사용 부호와 잔액 계산 |
| `point_accounts` | 후기·회원 구매 포인트 잔액 | `use_points`, 후기 보상, 이중화 정합성 |

실제 PG가 연결되지 않은 현재 상태는 [REQUIREMENTS.md](./REQUIREMENTS.md)의 **미완성** 판정을 따릅니다.

### 7-4. 개인정보와 커뮤니케이션

| 테이블 | 보호 이유 | 변경 시 필수 확인 |
|---|---|---|
| `center_members` | 센터별 회원 상태·메모·등급 | 소속 센터 매니저만 접근 |
| `inquiry_threads`, `inquiry_messages` | 회원-센터 비공개 대화 | 참여자·소속 센터 RLS와 Realtime |
| `notifications` | 계정별 알림 | 수신 계정 제한과 읽음 처리 |
| `center_reviews` | 프로필 작성 후기 | 공개 조회와 본인 작성·수정, 센터 답변 권한 |
| `business-licenses` bucket | 사업자등록증 | 비공개 유지, 가입자 업로드, 운영자 조회 |

## 8. 핵심 관계와 제약

### 8-1. 주요 관계

```text
accounts 1 ── * profiles
accounts 1 ── * manager_centers * ── 1 centers

centers 1 ── * classes 1 ── * reservations * ── 1 profiles
profiles 1 ── * memberships * ── 1 centers
memberships 1 ── * reservations

centers 1 ── * products
products 1 ── * memberships
classes * ── * products      (class_allowed_products)

centers 1 ── * orders
centers 1 ── * payments
profiles 1 ── * orders/payments/progress_records

center_roles 1 ── * role_permissions * ── 1 permissions
manager_centers * ── 1 center_roles
```

### 8-2. 핵심 제약

- `reservations`는 같은 `class_id`·`profile_id`의 활성 예약(`confirmed`, `waitlisted`) 중복을 제한합니다.
- `memberships.remaining_count`는 음수가 될 수 없습니다.
- 예약·주문·결제·수강권 상태는 SQL CHECK와 RPC가 기대하는 기존 값만 사용해야 합니다.
- 플랫폼 운영자 권한은 일반 가입 흐름에서 획득할 수 없어야 합니다.
- 승인되지 않은 센터는 일반 회원 공개 조회 대상이 아니어야 합니다.
- 정확한 컬럼과 FK는 `schema.sql`과 후속 `add_*.sql`·`fix_*.sql`을 함께 확인해야 합니다.

`schema.sql`에도 일부 후속 기능 테이블이 포함되어 있고 동일 객체가 후속 SQL에서 다시 생성·변경됩니다. 따라서 `schema.sql`만 현재 최종 스키마로 간주할 수 없습니다.

## 9. 핵심 RPC

아래 RPC는 `app/`·`lib/`에서 직접 호출되는 것을 확인했습니다.

### 9-1. 예약·수강권

| RPC | 호출 코드 | 역할 | 주의 |
|---|---|---|---|
| `reserve_class` | `lib/reservations.ts` | 일반 수업 예약 | 여러 SQL 파일에서 재정의됨 |
| `reserve_class_with_goods` | `lib/reservations.ts` | 굿즈 차감을 포함한 예약 | 상품 잔여량과 예약을 함께 변경 |
| `cancel_reservation` | `lib/reservations.ts` | 취소, 수강권 복구/차감, 대기 승격 | 여러 SQL 파일에서 재정의됨 |
| `usable_memberships_for_classes` | `lib/reservations.ts` | 여러 수업의 사용 가능한 수강권 배치 조회 | 최종 본문은 `add_class_trainers_pass_selection_mode_draft_proposed.sql`(2026-08-11, 적용 완료)이 재정의, `fix_security_definer_hardening_search_path_execute_draft_proposed.sql`(2026-08-13, 적용 완료)이 본문 변경 없이 search_path 고정 + EXECUTE를 authenticated로 제한. `add_usable_memberships_issued_at_draft_proposed.sql`(2026-08-25, **미적용 — 사용자 확인 대기**)이 RETURNS TABLE에 `issued_at` 추가 예정(A-8) |
| `reserve_with_membership` | `lib/reservations.ts` | 지정 수강권으로 예약 | 공유 방식 최종 적용 여부 확인 필요 |
| `manager_book_member` | `lib/classes.ts` | 매니저 보강 예약 | 권한과 수강권 차감 확인 |
| `manager_set_attendance` | `lib/classes.ts` | 출석·노쇼·취소 상태 처리 | 정의가 중복되어 최종 본문 확인 필요 |
| `add_holiday_safe` | `lib/holidays.ts` | 휴무일 등록과 수업·예약 정리 | 파급 범위가 큰 트랜잭션 |
| `delete_class_safe` | `lib/classes.ts` | 수업 안전 삭제 | 예약 취소·복구 포함 |
| `delete_class_group_safe` | `lib/classes.ts` | 반복수업 그룹 안전 삭제 | 다수 수업·예약 변경 |
| `auto_book_membership` | `lib/classes.ts` | 요일반 수강권 자동예약 및 재시도 | 하루 한 번 제한 보정본 확인 |
| `unplaced_weekday_passes` | `lib/classes.ts` | 자동예약 미배치 잔여분 조회 | 매니저 재시도 UI에서 사용 |
| `admin_assign_reservation` | `lib/adminAssignment.ts` | 관리자 직접배치(수강권/미배치건 사용)·무료 추가배치(차감 없음) | `add_admin_assignment.sql`. 정원 초과 시 1차 호출은 `needs_capacity_confirm`만 반환하고 미생성, `p_force_capacity`로 재호출해야 실제 생성됨 |
| `admin_cancel_reservation` | `lib/adminAssignment.ts` | 관리자 배치(ADMIN_ASSIGNMENT/ADMIN_FREE) 취소, 타입별 정확한 복구 | `add_admin_assignment.sql`. MEMBER 타입 예약에는 사용 불가(기존 `cancel_reservation`/`manager_set_attendance` 유지) |
| `can_manage_center_reservations` | `add_admin_assignment.sql` 내부 | 센터 관리자 권한 판정 헬퍼(`manager_book_member`와 동일 정책) | 세부 permission key 확장 지점, [TODO P1-9](./TODO.md) |
| `is_profile_assignable` | `add_admin_assignment.sql` 내부 | 회원 자격 판정 헬퍼(현재는 프로필 존재 여부만 확인) | 이용정지/탈퇴 등 정책 확장 지점, [TODO P1-10](./TODO.md) |

`usable_memberships()`는 SQL에 존재하지만 현재 앱은 배치용 `usable_memberships_for_classes()`와 `reserve_with_membership()`을 직접 호출합니다. 두 함수 모두 `fix_usable_memberships_product_kind.sql`에서 `products.product_kind = 'pass'` 조건이 추가되어, 구매용 상품(goods)이 더 이상 반환되지 않습니다.

### 9-2. 주문·환불·포인트

| RPC | 호출 코드 | 역할 | 주의 |
|---|---|---|---|
| `fulfill_order` | `lib/orders.ts` | 주문을 수강권·상품·매출로 발급 | 여러 SQL 파일에서 재정의됨, 중복 발급 방지 필수 |
| `refund_membership` | `lib/mypage.ts` | 조건부 수강권 환불 | 환불 정책이 코드·SQL에 고정 |
| `use_points` | `lib/reviews.ts` | 회원 포인트 사용 | `point_accounts` 기준, 이원화 확인 필요 |

### 9-3. 후기·공지·알림·문의

| RPC | 호출 코드 | 역할 |
|---|---|---|
| `write_review` | `lib/reviews.ts` | 후기 작성과 포인트 처리 |
| `reply_review` | `lib/reviews.ts` | 센터 후기 답변 |
| `center_review_stats` | `lib/reviews.ts` | 센터 후기 통계 |
| `create_announcement` | `lib/announcements.ts` | 공지 작성과 알림 생성 |
| `mark_notifications_read` | `lib/notifications.ts` | 알림 읽음 처리 |
| `open_inquiry_thread` | `lib/inquiries.ts` | 문의방 생성 |
| `read_inquiry_thread` | `lib/inquiries.ts` | 문의방 읽음 처리 |
| `send_inquiry_message` | `lib/inquiries.ts` | 문의 메시지 발송 |

`notify_upcoming_reservations()`와 `notify_expiring_passes()`는 앱에서 직접 호출하지 않습니다. 함수는 SQL에 존재하지만 pg_cron 등 실행 주체가 저장소에 없어 **운영 설정 필요**입니다.

## 10. 권한 헬퍼와 RLS

### 10-1. 핵심 권한 헬퍼

| 함수 | 역할 | 주의 |
|---|---|---|
| `my_account_id()` | 현재 Auth 사용자의 `accounts.id` | `security definer` 패턴 유지 |
| `my_profile_ids()` | 현재 계정이 소유한 프로필 집합 | 프로필 RLS 회귀 이력 있음 |
| `my_managed_center_ids()` | 현재 계정이 관리하는 센터 집합 | 계정 조회 재귀 방지본 확인 |
| `is_platform_admin()` | 플랫폼 운영자 여부 | self-service 승격 경로 금지 |
| `has_permission(center_id, key)` | 센터 역할·개인 예외를 반영한 권한 판정 | 예약·매출·회원 RPC에서 폭넓게 사용 |

### 10-2. RLS 보호 원칙

- 새 테이블은 생성 SQL과 같은 migration에서 RLS를 활성화하고 정책을 정의합니다.
- 회원·매니저·오너·플랫폼 운영자 각각의 read/write 경계를 검토합니다.
- 정책이 다른 테이블을 조회할 때 재귀가 발생하지 않도록 검증합니다.
- `using`뿐 아니라 insert/update의 `with check`를 확인합니다.
- 공개 조회 테이블이라도 쓰기 정책은 역할에 맞게 제한합니다.
- Storage bucket도 `storage.objects` 정책을 별도로 검증합니다.

### 10-3. 회귀 이력이 있는 SQL

| 파일 | 보호 대상 또는 문제 |
|---|---|
| `fix_profile_rls_restore.sql` | 매니저의 센터 회원 프로필 조회 복구 |
| `fix_missing_primary_profile.sql` | 대표 프로필 없음·중복 계정 복구 |
| `fix_rls_policies.sql` | `with check` 누락 정책 보정 |
| `fix_membership_rls.sql` | 수강권 발급과 회원 검색 RLS |
| `fix_staff_search.sql` | `accounts` 정책 무한 재귀 |
| `add_roster_rls.sql` | 예약자 명단 조회 |
| `fix_member_status.sql` | 회원 만료·휴면 상태 변경 |
| `fix_center_reviews.sql` | 기존 `reviews`와 센터 후기 테이블 충돌 |

이 파일들이 저장소에 있다는 사실은 확인되지만 운영 DB에 모두 적용되었는지는 **확인 필요**입니다.

## 11. 핵심 트리거

| 트리거 | 대상 | 역할 | 상태 |
|---|---|---|---|
| `trg_create_default_center_roles` | `centers` | 센터 생성 시 기본 역할 생성 | SQL 정의 확인, 운영 적용 확인 필요 |
| `trg_guard_center_status` | `centers` | 일반 매니저의 센터 승인 상태 변경 방지 | 두 SQL 파일에 정의, 운영 최종 정의 확인 필요 |
| `notify_new_order` | `orders` | 신규 주문 알림 생성 | SQL 정의 확인, 운영 적용 확인 필요 |
| `notify_new_review` | `center_reviews` | 신규 후기 알림 생성 | SQL 정의 확인, 운영 적용 확인 필요 |
| `notify_reservation_insert` | `reservations` | 신규 예약·대기 알림 생성 | SQL 정의 확인, 운영 적용 확인 필요. `add_admin_assignment.sql`이 함수 본문을 `reservation_type`에 따라 분기하도록 확장(트리거 자체는 재생성하지 않음) |
| `notify_reservation_update` | `reservations` | 예약 취소·상태 변경 알림 생성 | 위와 동일 — 관리자 배치/취소는 회원에게만 내부 정보 없이 안내, 다른 매니저에게는 알리지 않음 |

자동예약은 trigger가 아니라 `fulfill_order()` 내부에서 `auto_book_membership()`을 호출하는 함수 흐름입니다. 정기 리마인드도 DB trigger가 아니라 외부 스케줄러가 호출해야 하는 함수입니다.

## 12. SQL 파일과 적용 상태

저장소에는 기본 스키마, 기능별 추가, 보정, 진단·초기화 파일을 합쳐 67개 SQL 파일이 있습니다.

### 12-1. 기준 파일

| 파일 | 역할 |
|---|---|
| `schema.sql` | 기본 테이블, 초기 권한 카탈로그, 기본 RLS와 helper |
| `reservation_functions.sql` | 예약 RPC와 다수 RLS를 합친 기준 스크립트 |
| `auth_policies.sql` | 회원가입에 필요한 계정·프로필 insert 정책 |
| `setup_storage.sql` | `business-licenses` Storage bucket과 정책 |

### 12-2. 기능별 migration

```text
add_account_address.sql        add_admin_assignment.sql       add_announcements.sql
add_attendance.sql
add_auto_booking.sql           add_center_category.sql        add_center_intro.sql
add_center_location.sql        add_center_media.sql           add_center_settings.sql
add_center_shop.sql            add_class_goods_option.sql     add_class_products.sql
add_direct_payment.sql         add_holiday_sync.sql           add_inquiries.sql
add_intro_blocks.sql           add_makeup_booking.sql         add_member_dormant.sql
add_member_management.sql      add_membership_rules.sql       add_new_permissions.sql
add_notification_triggers.sql add_notifications.sql          add_operator_settings.sql
add_order_fulfillment.sql      add_orders.sql                 add_pass_binding.sql
add_pay_methods.sql            add_personal_permissions.sql   add_platform_admin.sql
add_product_extras.sql         add_profile_extras.sql         add_profile_fields.sql
add_progress_categories.sql    add_recurring_group.sql        add_refund_and_membership.sql
add_reservation_memo.sql       add_review_reply.sql           add_reviews_points.sql
add_rooms.sql                  add_rooms_fix.sql              add_roster_rls.sql
add_sales.sql                  add_same_day_setting.sql       add_shared_passes.sql
add_staff_permissions.sql      add_unplaced_passes.sql        wire_settings.sql
```

`add_admin_assignment.sql`(2026-07-30, `feature/p1-reservation-ux`)은 예약 타입 구조화(§4-2 참고)와
`admin_action_logs`, `admin_assign_reservation`/`admin_cancel_reservation` RPC를 추가하고
`reserve_class`/`reserve_with_membership`/`manager_book_member`/`cancel_reservation`/
`manager_set_attendance`/알림 트리거를 `create or replace`로 확장합니다(기존 로직·반환값은 유지).

### 12-3. 보정 migration

```text
fix_auto_book_oneperday.sql    fix_center_reviews.sql          fix_class_delete.sql
fix_member_status.sql          fix_membership_rls.sql         fix_missing_primary_profile.sql
fix_profile_rls_restore.sql    fix_rls_policies.sql           fix_staff_search.sql
fix_usable_memberships_product_kind.sql
fix_usable_memberships_shared.sql
fix_waitlist.sql
```

`fix_usable_memberships_product_kind.sql`(2026-07-30)은 `usable_memberships()`/
`usable_memberships_for_classes()`에 `products.product_kind = 'pass'` 조건을 추가해 구매용 상품(goods)이
"사용 가능한 수강권" 목록에 섞여 보이던 버그를 고칩니다.

### 12-4. 운영·진단·테스트 파일

| 파일 | 용도 | 주의 |
|---|---|---|
| `diagnose_profile.sql` | 프로필 오류 진단 | 스키마 변경 아님 |
| `seed_data.sql` | 테스트 데이터 | 운영 실행 전 내용 확인 |
| `reset_class_products.sql` | 수업-상품·예약조건 초기화 | 데이터 변경, 운영 사용 주의 |
| `reset_test_data.sql` | 테스트 데이터 전체 삭제 | 파괴적, 운영 실행 금지 |

### 12-5. 적용 순서 주의

README가 안내하는 큰 순서는 `schema.sql → reservation_functions.sql → add/fix SQL`이지만, 이것만으로 67개 파일의 재현 가능한 전체 순서가 검증되지는 않습니다.

특히 다음 함수는 여러 migration에서 `create or replace`됩니다.

- `reserve_class`
- `cancel_reservation`
- `fulfill_order`
- `manager_set_attendance`
- `usable_memberships`
- `reserve_with_membership`
- `auto_book_membership`
- `has_permission`
- `is_platform_admin`

따라서 새 환경 구축이나 운영 장애 조사 시에는 다음을 **확인 필요**로 처리합니다.

1. 운영 DB에 적용된 migration 목록과 실제 순서
2. `pg_get_functiondef()`로 조회한 현재 함수 본문
3. `pg_policies`의 현재 RLS 정책
4. `pg_trigger`의 활성 trigger
5. Realtime publication과 pg_cron 설정

검증된 migration ledger가 생기기 전까지 이 문서의 파일 목록을 그대로 실행 순서로 사용하면 안 됩니다.

## 13. DB 변경 시 문서 갱신 규칙

1. 새 테이블·뷰·RPC·trigger를 추가하면 이 문서의 해당 분류에 기록합니다.
2. 화면과 데이터 흐름이 연결된 경우에만 **구현됨**으로 표시합니다.
3. SQL만 존재하면 **확인 필요**, 외부 Supabase 설정이 필요하면 **운영 설정 필요**로 표시합니다.
4. 코드에서 참조가 사라진 테이블은 즉시 삭제 대상으로 단정하지 않고 5절 또는 6절로 이동합니다.
5. 상태값, FK, RLS, RPC 본문을 바꾸면 7~11절의 보호 대상과 호출 흐름을 함께 검토합니다.
6. 기존 RPC를 `create or replace`하면 그 함수를 정의하는 모든 SQL 파일과 현재 앱 호출자를 확인합니다.
7. 운영 DB 적용 여부는 저장소 상태로 추측하지 않습니다.
8. 파괴적 변경은 데이터 보존·백필·롤백 계획과 사용자 승인이 필요합니다.
9. 제품 기능 상태가 달라지면 [REQUIREMENTS.md](./REQUIREMENTS.md), 후속 작업은 [TODO.md](./TODO.md), 완료 이력은 [CHANGELOG.md](./CHANGELOG.md)에 반영합니다.
