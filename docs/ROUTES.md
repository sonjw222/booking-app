# ROUTES

## 1. 문서 메타데이터

| 항목 | 값 |
|---|---|
| 문서 목적 | 실제 App Router 화면, 사용자 유형, 주요 기능, 데이터 의존성과 접근 통제의 기준선 |
| 최종 검증일 | 2026-07-28 |
| 검증 대상 | `app/**/page.tsx`와 각 페이지가 호출하는 `lib/*.ts` |
| 실제 페이지 수 | 41개 |
| 한계 | 운영 Supabase의 RLS·Realtime·migration 적용 상태는 저장소만으로 확인할 수 없음 |
| 관련 문서 | [요구사항과 상태](./REQUIREMENTS.md) · [DB/RLS/RPC](./DATABASE.md) · [후속 작업](./TODO.md) |

## 2. 분류와 접근 통제 기준

상태 표현은 [REQUIREMENTS.md](./REQUIREMENTS.md)를 따릅니다.

| 표기 | 의미 |
|---|---|
| **구현됨** | 화면과 데이터 로직이 연결되어 있음 |
| **미완성** | 화면 일부 또는 외부 연동이 완성되지 않음 |
| **확인 필요** | 저장소만으로 운영 설정이나 최종 접근 상태를 확정할 수 없음 |
| **운영 설정 필요** | OAuth Provider, Realtime, pg_cron 등 외부 설정이 필요함 |

사용자 유형:

- **공개**: 로그인하지 않아도 주요 데이터를 볼 수 있는 화면
- **회원**: 로그인 계정과 `profiles`가 필요한 화면
- **센터 매니저**: `manager_centers` 소속이 필요한 화면
- **플랫폼 운영자**: `accounts.is_platform_admin = true`가 필요한 화면

### 공통 접근 통제 구조

- Next.js middleware와 루트 레이아웃의 전역 인증 가드는 없습니다.
- 회원 페이지는 비로그인 사용자를 일괄 `/login`으로 보내지 않습니다. 페이지 셸은 렌더링되고 데이터 함수가 “로그인이 필요해요” 오류를 반환하는 방식입니다.
- 다수의 매니저 페이지는 `fetchMyCenters()`로 센터 소속을 클라이언트에서 먼저 확인합니다.
- 매니저의 세부 권한은 대부분 화면에서 메뉴·버튼을 숨기는 데 사용되지 않습니다. 최종 쓰기 제한은 `has_permission()`을 사용하는 RLS/RPC에 의존합니다.
- 플랫폼 운영자 페이지는 `checkPlatformAdmin()` 사용 여부가 페이지마다 다릅니다.
- 클라이언트 가드가 있더라도 최종 보안 경계는 Supabase RLS/RPC입니다. 세부 데이터 보호 대상은 [DATABASE.md](./DATABASE.md)를 참고합니다.

## 3. 공개 및 공용 라우트

| 라우트 | 사용자 | 주요 기능 | 주요 데이터 의존성 | 권한 처리와 상태 |
|---|---|---|---|---|
| `/` | 공개 + 로그인 회원 | 홈 센터·수업·카테고리·배너, 로그인 회원의 예정 수업 | `centers`, `classes`, `class_reservation_counts` view, `service_categories`, `home_banners`; 로그인 시 `accounts`, `profiles`, `memberships` | 공개 데이터는 RLS 공개 조회. 개인 예정 수업은 로그인한 경우에만 조회. **구현됨** |
| `/search` | 공개 | 센터명·종목 검색 | `centers`, `service_categories`, 이미지 Storage | 공개 조회 정책에 의존. **구현됨** |
| `/category/[label]` | 공개 | 선택 종목의 센터 목록 | `centers`, `service_categories`, 이미지 Storage | 공개 조회 정책에 의존. **구현됨** |
| `/center/[id]` | 공개 + 로그인 회원 | 센터 소개·수업·상품·후기, 장바구니, 후기 작성, 예약·구매 진입 | `centers`, `classes`, `class_reservation_counts` view, `products`, `class_allowed_products`, `memberships`, `center_reviews`, `point_accounts`, `profiles`; `write_review` | 센터·수업·후기는 공개 조회. 장바구니·후기·포인트는 로그인과 본인 RLS 필요. **구현됨** |
| `/login` | 공개 | 이메일 회원가입·로그인, 카카오·애플 OAuth, 회원/매니저 가입, 사업자등록증 업로드 | Supabase Auth, `accounts`, `profiles`, `centers`, `manager_centers`, `business-licenses` Storage | 이메일 흐름은 **구현됨**. 카카오·애플은 **운영 설정 필요**. 네이버 로그인은 **미완성**. 파일 업로드는 구현됐지만 과거 TODO 주석이 남아 있음 |

## 4. 회원 라우트

아래 라우트에는 공통 라우트 가드가 없습니다. 비로그인·프로필 없음·RLS 거부는 각 데이터 함수의 오류 처리에 의존합니다.

| 라우트 | 사용자 | 주요 기능 | 주요 데이터 의존성 | 권한 처리와 상태 |
|---|---|---|---|---|
| `/reservation` | 회원 | 월간 수업·휴무일 조회, 수강권 예약·취소, 대기, 굿즈 사용, 구매 가능한 상품 안내 | `classes`, `class_reservation_counts` view, `center_holidays`, `profiles`, `memberships`, `products`, `class_allowed_products`, `member_center_colors`, `reservations`; `reserve_class`, `reserve_class_with_goods`, `reserve_with_membership`, `cancel_reservation`, `usable_memberships_for_classes` | 본인 프로필·수강권 RLS와 예약 RPC에 의존. 국경일은 2026-07-17 한 건만 하드코딩되어 **미완성** |
| `/my-reservations` | 회원 | 내 예약 목록, 상태 필터, 캘린더 진입 | `accounts`, `profiles`, `memberships`, `reservations` | 로그인·본인 데이터 RLS 필요. **구현됨** |
| `/cart` | 회원 | 장바구니 조회·수량/사이즈 변경·삭제, 주문 생성 | `accounts`, `profiles`, `cart_items`, `centers`, `products`, `orders` | 본인 장바구니·주문 RLS 필요. 쿠폰은 화면 입력만 있고 실제 할인 검증은 확인되지 않아 **확인 필요** |
| `/checkout` | 회원 | 상품 주문서, 포인트 사용, 주문 생성, 예약 화면 복귀 | `centers`, `products`, `orders`, `point_accounts`; `use_points` | 로그인 필요. 실제 PG 처리 없이 `pending` 주문만 생성하므로 결제는 **미완성** |
| `/purchases` | 회원 | 수강권·상품 구매 내역, 조건부 환불 | `accounts`, `profiles`, `orders`, `memberships`; `refund_membership` | 본인 구매 데이터 RLS 필요. 발급 후 24시간 이내·미사용 환불은 구현됨. 미발급 주문의 앱 내 취소는 **미완성** |
| `/mypage` | 회원 | 프로필·수강권 현황, 최근 예약, 환불, 로그아웃 | `accounts`, `profiles`, `memberships`, `reservations`; `refund_membership` | 로그인·본인 데이터 RLS 필요. 포인트 잔액은 이 화면에 없음. **구현됨** |
| `/mypage/calendar` | 회원 | 프로필별 색상 예약 달력, 날짜별 수업, 개인 메모 | `profiles`, `reservations`, `member_center_colors` | 본인 프로필·예약 RLS 필요. **구현됨** |
| `/mypage/history` | 회원 | 전체 예약 이력과 상태 필터 | `profiles`, `reservations` | 본인 예약 RLS 필요. **구현됨** |
| `/profiles` | 회원 | 수강 프로필 추가·편집·삭제, 대표 프로필 보호, 사진 | `accounts`, `profiles`, `avatars` Storage | 로그인·본인 프로필 RLS 필요. **구현됨** |
| `/notifications` | 회원 | 알림 목록·전체 읽음, 공지 상세, 관련 화면 이동 | `accounts`, `notifications`, `center_announcements`; `mark_notifications_read` | 수신 계정 RLS 필요. Realtime과 자동 알림은 **운영 설정 필요** |
| `/inquiries` | 회원 | 문의방 목록, 센터 선택, 실시간 메시지·사진 전송 | `accounts`, `profiles`, `memberships`, `centers`, `inquiry_threads`, `inquiry_messages`, `avatars` Storage; 문의 RPC | 참여 회원 RLS 필요. Realtime publication은 **운영 설정 필요** |
| `/settings/notifications` | 회원 성격의 로컬 설정 | 예약·리마인더·마케팅 알림 선호 설정 | 브라우저 `localStorage` | 서버 저장·실제 푸시·알림톡 발송과 연결되지 않아 **미완성**. 로그인 강제 없음 |
| `/settings/theme` | 공용 로컬 설정 | 버건디·네이비·세이지·차콜 테마 선택 | 브라우저 `localStorage`, `<html data-theme>` | DB·로그인 의존성 없음. **구현됨** |

## 5. 센터 매니저 라우트

19개 매니저 페이지 중 16개가 `fetchMyCenters()`를 호출합니다. `/manager/inquiries`, `/manager/notifications`, `/manager/staff/permissions`는 이 클라이언트 소속 확인이 없고 RLS/RPC에만 의존합니다.

페이지 상단 주석에 특정 권한 키가 적혀 있어도 일반 기능 화면은 그 권한으로 UI를 숨기지 않습니다. `/manager/staff/permissions`는 권한을 설정·계산하는 화면이며, 다른 페이지에 권한 UI 제한을 적용하는 공통 가드는 아닙니다.

| 라우트 | 사용자 | 주요 기능 | 주요 데이터 의존성 | 권한 처리와 상태 |
|---|---|---|---|---|
| `/manager` | 센터 매니저 | 센터 전환, 오늘 수업·예약 현황, 출결, 회원 상세, 관리 메뉴 | `manager_centers`, `accounts`, `classes`, `class_reservation_counts` view, `reservations`, `center_members`, `profiles`, `memberships`; 출결 RPC | `fetchMyCenters()` 사용. 상세 권한 UI 제한 없음. 상단의 “일부는 다음 단계에서 실연동” 주석은 현재 여러 메뉴가 연결된 코드와 달라 **확인 필요** |
| `/manager/classes` | 센터 매니저 | 수업 CRUD, 반복수업·복사, 예약자·출결, 보강 예약, 자동예약 재시도, 관리자 직접배치·무료 추가 배치 | `classes`, `class_reservation_counts` view, `rooms`, `center_holidays`, `reservations`, `center_members`, `memberships`, `products`, `class_allowed_products`, `membership_schedule_rules`, `admin_action_logs`; 수업·출결·보강·자동예약·`admin_assign_reservation`/`admin_cancel_reservation` RPC | `fetchMyCenters()` 사용. 최종 쓰기는 RLS/RPC. “다시 배치” UI까지 **구현됨** |
| `/manager/admin-assignments` | 센터 매니저 | 관리자 직접배치/무료 추가배치/취소 작업 로그 조회 + 필터(기간/회원·관리자·수업/타입/작업/사유/정원초과) | `admin_action_logs`, `accounts` | `fetchMyCenters()` 사용. 통계·엑셀 다운로드는 범위 제외. **구현됨** |
| `/manager/rooms` | 센터 매니저 | 룸 추가·수정·삭제, 주소와 지도 | `rooms` | `fetchMyCenters()` 사용, RLS 최종 제한. **구현됨** |
| `/manager/membership-rules` | 센터 매니저 | 수강권 상품 CRUD, 수업 허용 상품, 요일·시간·수업명 조건 | `products`, `classes`, `class_allowed_products`, `membership_schedule_rules` | `fetchMyCenters()` 사용. 주석의 `pass.update` 권한은 UI에서 선검사하지 않으며 RLS에 의존. **구현됨** |
| `/manager/goods` | 센터 매니저 | 굿즈·대여 상품 CRUD, 무제한·횟수 옵션 | `products` | `fetchMyCenters()` 사용. `pass.update` UI 선검사 없음. **구현됨** |
| `/manager/members` | 센터 매니저 | 회원 검색·필터, 등급·상태·메모·주소, 상세, CSV, 회원 추가 | `accounts`, `profiles`, `center_members`, `member_grades`, `memberships`, `payments`, `products`, `reservations`, `progress_records` | `fetchMyCenters()` 사용, 회원 RLS 최종 제한. 담당회원·상담고객 탭은 안내만 있어 **미완성** |
| `/manager/progress` | 센터 매니저 | 진도 대분류·세부기술 CRUD | `progress_categories` | `fetchMyCenters()` 사용. `customer.progress` UI 선검사 없음. **구현됨** |
| `/manager/progress/record` | 센터 매니저 | 회원 선택, 진도 기록·삭제·메모와 이력 | `accounts`, `center_members`, `progress_categories`, `progress_records` | `fetchMyCenters()` 사용. `customer.progress` UI 선검사 없음. **구현됨** |
| `/manager/sales` | 센터 매니저 | 기간별 매출, 분할결제, 미수금, 지출, 포인트, 담당 강사 | `manager_centers`, `center_members`, `memberships`, `products`, `payments`, `expenses`, `point_transactions` | `fetchMyCenters()` 사용, 매출 RLS 최종 제한. 실제 PG가 아닌 매니저 수기 매출 관리 화면. **구현됨** |
| `/manager/orders` | 센터 매니저 | 회원 주문 조회, 발급 완료·취소 처리 | `manager_centers`, `orders`, `accounts`, `profiles`, `memberships`; `fulfill_order` | `fetchMyCenters()` 사용, 주문 RPC/RLS 최종 제한. 주문은 PG 결제 없이 `pending`으로 들어오므로 거래 흐름은 **미완성** |
| `/manager/reviews` | 센터 매니저 | 센터 후기 조회, 답변 작성·수정, 삭제 | `center_reviews`, `accounts`, `profiles`; `reply_review` | `fetchMyCenters()` 사용, 후기 RLS/RPC 최종 제한. **구현됨** |
| `/manager/announcements` | 센터 매니저 | 공지 CRUD, 서식·사진, 관련 회원 알림 | `center_announcements`, `avatars` Storage; `create_announcement` | `fetchMyCenters()` 사용. 공지·알림 RLS/RPC에 의존. **구현됨**, Realtime 알림은 **운영 설정 필요** |
| `/manager/inquiries` | 센터 매니저 | 센터 문의방 목록과 실시간 답변 | `inquiry_threads`, `inquiry_messages`, `accounts`, `profiles`, `avatars` Storage; 문의 RPC | `fetchMyCenters()` 없음. 센터 소속 RLS/RPC에만 의존. 화면 사전 차단은 **미완성**, Realtime은 **운영 설정 필요** |
| `/manager/notifications` | 센터 매니저 | 신규 주문·후기·예약·취소 알림, 전체 읽음 | `accounts`, `notifications`; `mark_notifications_read` | `fetchMyCenters()` 없음. 수신 계정 RLS에 의존. 화면 사전 차단은 **미완성**, Realtime은 **운영 설정 필요** |
| `/manager/holidays` | 센터 매니저 | 휴무일 추가·삭제, 관련 수업·예약 정리 | `center_holidays`; `add_holiday_safe` | `fetchMyCenters()` 사용, RPC/RLS 최종 제한. **구현됨** |
| `/manager/center-info` | 센터 매니저 | 소개·사진·블록·주소·좌표·연락처·SNS·종목 편집 | `centers`, `service_categories`, `avatars` Storage | `fetchMyCenters()` 사용. `facility.info` UI 선검사 없음. **구현됨** |
| `/manager/settings` | 센터 매니저 | 예약·취소·폐강·대기 등 센터 운영 설정 | `center_settings` | `fetchMyCenters()` 사용. `facility.operation` UI 선검사 없음. **구현됨** |
| `/manager/staff` | 센터 매니저·오너 | 스태프 초대·역할 변경·삭제, 역할별 권한 편집 | `accounts`, `manager_centers`, `center_roles`, `permissions`, `role_permissions` | `fetchMyCenters()` 사용. 최종 권한은 RLS와 `has_permission()`에 의존. **구현됨** |
| `/manager/staff/permissions` | 센터 매니저·오너 | 특정 스태프 개인별 권한 allow/deny 오버라이드 | `accounts`, `manager_centers`, `center_roles`, `permissions`, `role_permissions`, `account_center_permissions` | `fetchMyCenters()` 없음. URL query의 대상과 RLS에 의존. 오너 전용 사전 가드는 없어 화면 접근 처리는 **미완성** |

## 6. 플랫폼 운영자 라우트

| 라우트 | 사용자 | 주요 기능 | 주요 데이터 의존성 | 권한 처리와 상태 |
|---|---|---|---|---|
| `/admin` | 플랫폼 운영자 | 운영자 설정 허브 | `accounts` | `checkPlatformAdmin()`으로 콘텐츠를 차단. RLS 최종 제한. **구현됨** |
| `/admin/centers` | 플랫폼 운영자 | 센터 대기·승인·반려·복원, 사업자 정보 확인 | `accounts`, `centers`, `business-licenses` Storage | `checkPlatformAdmin()` 사용. 상태 변경은 RLS/RPC 보호. **구현됨** |
| `/admin/categories` | 플랫폼 운영자 의도 | 서비스 종목 추가·삭제 | `service_categories` | `checkPlatformAdmin()` 없음. 공개 목록과 입력폼이 비운영자에게도 보이며 쓰기는 RLS가 거부. 화면 사전 차단은 **미완성** |
| `/admin/banners` | 플랫폼 운영자 의도 | 홈 배너 추가·삭제·노출 토글·순서 | `home_banners` | `checkPlatformAdmin()` 없음. 공개 목록과 입력폼이 비운영자에게도 보이며 쓰기는 RLS가 거부. 화면 사전 차단은 **미완성** |

## 7. 미완성·운영 설정 필요 상태 요약

| 범위 | 상태 |
|---|---|
| `/login` 네이버 로그인 | **미완성** |
| `/login` 카카오·애플 로그인 | **운영 설정 필요** |
| `/reservation` 국경일 | 한 건 하드코딩으로 **미완성** |
| `/checkout` 실제 결제 | 주문 접수만 구현되어 **미완성** |
| `/purchases` 미발급 주문 취소 | **미완성** |
| `/settings/notifications` | 로컬 설정만 있고 실제 발송은 **미완성** |
| 알림·문의 Realtime | 운영 Supabase 설정 **확인 필요 / 운영 설정 필요** |
| `/manager/members` 담당회원·상담고객 | **미완성** |
| 매니저 세부 권한 UI | 대부분 서버 거부에만 의존해 **미완성** |
| 매니저 클라이언트 소속 가드 | 3개 페이지에 없음 |
| 플랫폼 운영자 클라이언트 가드 | 2개 페이지에 없음 |

우선순위와 해결 계획은 [TODO.md](./TODO.md)를 기준으로 합니다.

## 8. 실제 라우트 통계

- 전체 `page.tsx`: 41개
- 공개·공용: 5개
- 회원·로컬 설정: 13개
- 센터 매니저: 19개
- 플랫폼 운영자: 4개
- 동적 세그먼트: `/category/[label]`, `/center/[id]`

이 문서에는 실제 `app/**/page.tsx`가 있는 화면만 포함합니다. `class_types`, 락커, 수강권 양도, 전자계약, 커뮤니티, 대회정보, 스태프 급여·근무일정처럼 스키마에만 있거나 화면 연결이 확인되지 않은 기능은 라우트로 기록하지 않습니다. 해당 DB 객체의 상태는 [DATABASE.md](./DATABASE.md)를 참고합니다.

## 9. 라우트 변경 시 문서 갱신 규칙

1. `page.tsx`를 추가·삭제·이동하면 실제 경로와 함께 이 문서를 갱신합니다.
2. 사용자 유형, 주요 기능, 데이터 객체와 RPC, 클라이언트 가드, 최종 RLS 처리 방식을 함께 기록합니다.
3. 화면 파일이 없으면 향후 계획만으로 라우트를 추가하지 않습니다.
4. SQL 테이블만 존재하는 기능을 실제 화면으로 표현하지 않습니다.
5. UI만 있고 데이터가 연결되지 않았으면 **미완성**, 운영 설정을 저장소에서 확인할 수 없으면 **운영 설정 필요** 또는 **확인 필요**로 표시합니다.
6. 권한 주석만으로 가드가 동작한다고 판단하지 않고 실제 함수 호출과 RLS/RPC를 확인합니다.
7. 기능 상태가 달라지면 [REQUIREMENTS.md](./REQUIREMENTS.md), 데이터 보호가 달라지면 [DATABASE.md](./DATABASE.md), 후속 작업은 [TODO.md](./TODO.md)에 반영합니다.
