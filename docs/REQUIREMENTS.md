# REQUIREMENTS

> `app/`, `lib/`, `*.sql`, `TEST_CHECKLIST*.md` 코드/문서 분석을 근거로 작성했습니다.
> "구현됨"은 화면(`app/**/page.tsx`)과 데이터 로직(`lib/*.ts`)이 실제로 연결되어 있다는 뜻이며 —
> **테이블이 스키마에 존재하는 것만으로는 "구현됨"으로 표시하지 않았습니다.**
> 아래 항목은 각 기능이 실제로 호출하는 `lib/*.ts` 함수와 테이블/RPC 존재를 직접 확인(grep)한 뒤 작성했으며,
> 확인 과정에서 스키마에는 있지만 실제 화면이 없는 기능을 다수 발견해 "미완성 기능" 절과 [DATABASE.md](./DATABASE.md) 1-8절에 별도 정리했습니다.
> 실제 운영 환경에서의 QA 여부는 보장하지 않습니다.

## 1. 현재 구현된 기능

### 인증/계정
- 이메일/비밀번호 회원가입·로그인 (`app/login/page.tsx`, Supabase Auth)
- 카카오/애플 소셜 로그인 UI (Supabase Provider 설정 필요, [AUTH_SETUP.md](../AUTH_SETUP.md))
- 계정(`accounts`) 1개가 회원 프로필 여러 개(`profiles`)와 매니저-센터 소속(`manager_centers`) 여러 개를 동시에 보유
- 매니저 가입 시 센터 자동 생성(상태 `pending`, 운영자 승인 필요) + 사업자등록증 업로드
  (Supabase Storage 비공개 버킷 `business-licenses`에 실제 업로드됨 — `lib/storage.ts`. `app/login/page.tsx:155`에 남아있는 옛 TODO 주석은
  이미 구현이 끝난 뒤에도 지워지지 않은 것으로 확인했습니다)

### 예약
- 달력 기반 월간 수업 조회, 공휴일/휴무일 표시 (`app/reservation`, `lib/reservations.ts`, `lib/holidays.ts`)
  - ⚠ 국경일(공휴일) 표시는 `app/reservation/page.tsx`에 하드코딩된 값 1건(`2026-07-17` 제헌절)뿐이며, 자동 갱신되지 않음. 센터 휴무일(`center_holidays`)과는 별개 — 자세한 내용은 [TODO.md](./TODO.md) 참고
- 수강권을 사용한 예약, 대기자 등록, 노쇼/출석 처리
- 대기자 자동 승격: 취소 시점에 `cancel_reservation` DB 함수가 대기 1순위를 자동으로 `confirmed`로 전환 (`fix_waitlist.sql`) — 별도 배치/스케줄러 없이 취소 트랜잭션 안에서 즉시 처리됨
- 프로필 간 수강권 공유(대표 프로필이 구매한 수강권을 자녀 프로필 등이 사용) — `add_shared_passes.sql`
- 수강권별 요일/시간/수업명 예약 제한 규칙(`membership_schedule_rules`)
- 요일반 수강권 자동예약: 수강권 발급(`fulfill_order` 등 DB 함수) 시점에 `auto_book_membership()`이 자동 호출되어 해당 요일 수업을 잔여 횟수만큼 예약, 하루 1회 제한 포함 (`add_auto_booking.sql`, `fix_auto_book_oneperday.sql`)
  - ⚠ 정원이 다 찬 뒤 재시도하는 `retryAutoBook()` 함수(`lib/classes.ts:604`)는 존재하지만, 이를 호출하는 버튼/화면을 `app/**/*.tsx`에서 찾지 못했습니다 — 자동예약 자체는 동작하지만 "재시도" UI는 미완성으로 보입니다(확인 필요)
- 다중예약 허용 수강권(`allow_multi_booking`)
- 예약 취소, 취소 가능 시간 이후 취소 시 횟수 차감 옵션(`center_settings.deduct_on_late_cancel`) — DB 함수와 설정 화면 양쪽에서 실제 연결 확인

### 수업/스케줄(매니저)
- 수업 생성/수정/삭제, 그룹·프라이빗 구분 (`lib/classes.ts`, 807줄 — 최대 모듈)
- 반복 수업 등록, 요일 기준/날짜 기준 스케줄 복사(`CopyCalendar.tsx`)
- 룸(공간) 관리
- 최소 인원 미달 자동 폐강, 예약/취소/대기 마감 시간 설정 (`center_settings`)
- ⚠ **확인 필요 — 수업별 담당 강사 배정 및 수업 구분(class_types) 관리는 스키마(`class_trainers`, `class_types` 테이블)에만 존재하고 `lib/classes.ts`에서 실제로 사용되지 않습니다.** 이전 버전 문서에 "담당 강사 복수 배정"으로 기재되어 있었으나 재검증 결과 근거를 찾지 못해 제거했습니다. 매출 화면에서 결제 건에 담당 강사 1명을 지정하는 기능(`payments.trainer_account_id`, `lib/sales.ts`)은 별개로 실제 존재합니다.

### 수강권/상품/매출
- 수강권 발급, 정지, 환불
  - ⚠ **확인 필요 — "양도" 기능**: `membership_transfers` 테이블이 스키마에 있고 이전 버전 문서에 "양도" 기능으로 기재했으나, 재검증 결과 `lib/*.ts` 어디에서도 이 테이블을 사용하는 코드나 프로필 간 수강권 재배정 로직을 찾지 못했습니다. `payments.sale_type`에 `transfer_fee`(양도수수료) 값은 존재해 매출 집계상 "양도"라는 개념 자체는 있으나, 실제 양도 처리 기능이 동작하는지는 확인이 필요합니다.
- 결제 등록(분할결제: 카드/현금/계좌이체/포인트), 미수금·위약금 처리 (`app/manager/sales`, `lib/sales.ts`)
- 지출 기록, 매출 리포트(`revenue_summary` 뷰 기반)
- 포인트 적립/사용 — ⚠ **확인 필요**: 매출 화면(`lib/sales.ts`)은 `point_transactions` 테이블을, 후기 화면(`lib/reviews.ts`)은 `point_accounts` 테이블을 각각 사용합니다. 두 시스템이 하나의 포인트 잔액으로 통합되어 있는지 코드만으로 확인할 수 없었습니다 — [DATABASE.md](./DATABASE.md) 1-3절 참고
- 상품(굿즈) 판매, 무제한/횟수 옵션

### 구매(회원 측)
- 장바구니(`app/cart`), 결제 화면(`app/checkout`)에서 주문 생성 → 상태 `pending`
- **주의**: 실제 PG(결제대행사) 연동 없음. "결제하기"는 주문서만 생성하고 센터가 수동으로 확인·발급 (아래 "미완성 기능" 참고)
- 매니저가 미배치 수강권(`add_unplaced_passes.sql`)을 회원에게 배정/발급(fulfill)

### 회원 관리(매니저)
- 회원 목록, 검색, 등급(`member_grades`) 부여, 상태(이용중/만료/휴면) 관리
- 회원 메모, 주소
- 예약 이력에서 자동으로 센터 회원 등록(`lib/members.ts`)
- CSV(엑셀) 내보내기
- ⚠ **확인 필요 — 락커**: `center_settings.use_locker` on/off 설정 화면만 있고, 락커 배정 UI나 `lockers`/`locker_assignments` 테이블을 사용하는 코드는 찾지 못했습니다. 이전 버전 문서의 "락커 배정" 기재는 근거 부족으로 제거했습니다.

### 후기
- 별점·사진 후기 작성, 센터 서식 있는 답변 (`add_review_reply.sql`)
- 후기 기반 포인트 적립 (`add_reviews_points.sql`)
- ⚠ 스키마의 커뮤니티 게시판(`community_posts`/`community_comments`), 대회정보(`competitions`) 테이블은 앱 코드에서 사용을 확인하지 못했습니다 — 실제 화면 없음 (확인 필요)

### 공지/알림/문의
- 매니저 공지사항 작성(서식·사진), 회원 열람
- 실시간 알림 팝업 + 알림함 (Supabase Realtime, `notifications` 테이블)
- 예약 리마인드, 수강권 만료 알림 — **DB 함수는 존재하나 자동 실행 스케줄러는 앱에 없음** (pg_cron 등 수동 설정 필요, README 참고)
- 1:1 문의 실시간 채팅 (`inquiry_threads`, `inquiry_messages`)

### 권한/역할(매니저)
- 센터별 역할(오너/매니저/강사 + 커스텀) 생성
- 권한 카탈로그 기반 역할별 권한 부여 (`permissions`, `role_permissions`)
- 개인별 권한 예외(허용/차단 오버라이드) — `account_center_permissions`
- 권한 판정 자체는 DB 함수 `has_permission(center_id, permission_key)`로 실제 동작하며, `reservation_functions.sql`을 비롯한
  여러 SQL 파일에서 폭넓게(40회 이상) 호출되어 씁니다 — 서버 단에서는 실제로 강제됩니다(직접 확인).
- ⚠ **확인됨 — 다만 프론트엔드는 이 권한에 따라 화면/버튼을 숨기거나 비활성화하지 않습니다.** 권한 판정 함수(`effectiveState()`, `lib/roles.ts`)는
  `/manager/staff/permissions`(권한을 "설정"하는 화면) 한 곳에서만 쓰이고, 다른 매니저 화면들은 로그인한 사람이 어떤 권한을 가졌는지와 무관하게
  동일한 메뉴/버튼을 모두 보여줍니다. 권한이 없는 조작은 버튼을 누른 뒤 서버(RLS/RPC)가 거부하는 방식으로만 막힙니다. 자세한 내용은 [ROUTES.md](./ROUTES.md) 3절 참고.

### 진도 관리
- 기술 카테고리 트리 구성, 회원별 진도 기록/삭제/메모

### 플랫폼 운영자
- 센터 가입 승인/반려 (`app/admin`, `lib/admin.ts`)
- 종목(카테고리) 관리, 홈 배너 관리

## 2. 미완성 기능 (코드/문구로 확인됨)

| 기능 | 상태 | 근거 |
|---|---|---|
| **실제 결제(PG) 연동** | 미구현. 주문만 생성되고 실제 카드/간편결제 처리 없음 | `app/checkout/page.tsx`: "결제 연동 전이라 실제 결제는 아직이에요", "실제 결제 연동은 준비 중이에요" |
| **네이버 소셜 로그인** | 버튼만 존재, 클릭 시 안내 메시지만 출력 | `app/login/page.tsx:237`, `AUTH_SETUP.md` "네이버 버튼은 눌러도 '설정 안 됨' 안내만 떠요" |
| **푸시/알림톡 실제 발송** | 설정 화면은 기기 로컬 저장만 하고 실제 발송 연동 없음. `messages`(발송기록) 테이블도 코드에서 미참조 | `app/settings/notifications/page.tsx:6` "실제 푸시/알림톡 발송 연동은 추후" |
| **예약 리마인드/만료 알림 자동 실행** | DB 함수(`notify_upcoming_reservations`, `notify_expiring_passes`)는 있으나 스케줄러 미설정 시 실행 안 됨 | `README.md` 5절 |
| **앱 내 환불** | 미발급 주문은 앱에서 취소 불가, 센터 문의 안내로 대체 | `app/purchases/page.tsx:49` |
| **`.env.local.example`** | README가 이 파일을 참조하지만 저장소에 실제 파일 없음 | 루트 디렉토리 확인 |
| **수업별 담당 강사 배정 / 수업 구분(class_types) 관리** | 스키마 테이블만 존재, `lib/classes.ts`에서 미사용 (확인 필요) | [DATABASE.md](./DATABASE.md) 1-2절, 1-8절 |
| **수강권 양도** | `membership_transfers` 테이블 존재하나 사용하는 코드를 찾지 못함 (확인 필요) | [DATABASE.md](./DATABASE.md) 1-3절 |
| **락커 배정** | 설정 on/off 토글만 존재, 배정 UI/코드 없음 (확인 필요) | [DATABASE.md](./DATABASE.md) 1-2절 |
| **요일반 자동예약 "재시도" 버튼** | `retryAutoBook()` 함수는 있으나 호출하는 UI를 찾지 못함(자동예약 본체는 정상 동작) (확인 필요) | `lib/classes.ts:604` |
| **전자계약서 / 상담고객(리드) / 커뮤니티 / 대회정보 / 스태프 급여·근무일정 / 팝업공지** | `permissions` 카탈로그·테이블만 존재, 화면 없음 (확인 필요) | [DATABASE.md](./DATABASE.md) 1-8절 |

## 3. 관리자 기능

두 종류의 "관리자"가 존재하므로 혼동 주의:

### 3-1. 플랫폼 운영자 (`/admin/*`, `is_platform_admin = true`)
- 센터 가입 승인/반려
- 종목(카테고리) 관리
- 홈 배너 관리
- DB에서 직접 권한 부여해야 함(가입만으로는 권한 없음) — `add_platform_admin.sql`

### 3-2. 센터 매니저 (`/manager/*`, `manager_centers` 소속)
역할에 따라 세분화(오너는 전권, 매니저/강사는 `permissions` 카탈로그로 세밀 제어):
- 대시보드(오늘 수업/예약 현황)
- 수업/스케줄 관리, 룸 관리
- 회원 관리, 진도 관리
- 매출/지출/포인트 관리
- 수강권 규칙(멤버십 룰) 관리
- 공지사항/후기 답변/1:1 문의 응대
- 스태프 및 권한 설정
- 센터 정보/운영 설정/휴무일 관리
- 주문(구매 요청) 확인 및 처리

## 4. 사용자(회원) 기능
- 홈에서 센터 검색/카테고리 필터
- 센터 상세 조회(소개, 수업 목록, 후기) — 포인트 잔액 표시도 이 화면(`app/center/[id]/page.tsx`)에서 확인
- 수업 예약/취소, 예약 캘린더, 내 예약 목록
- 수강권/상품 구매(주문 생성), 장바구니, 결제(주문서) 시 포인트 사용
- 마이페이지: 프로필 관리, 예약 이력(수강권 현황 포함)
  - ⚠ 정정: 이전 버전 문서에 마이페이지(`/mypage`)에서 포인트를 보여준다고 기재했으나, 재검증 결과 `app/mypage/page.tsx`에는 포인트 관련 코드가 없습니다. 포인트 잔액/사용은 센터 상세(`/center/[id]`)와 결제(`/checkout`) 화면에서 확인됩니다.
- 알림 설정(`/settings/notifications`), 테마 설정(`/settings/theme`) — 마이페이지와 별개의 독립 라우트
- 후기 작성
- 공지사항 열람
- 1:1 문의
- 알림함 확인

## 5. 예약 및 결제 관련 요구사항 (스키마에서 확인되는 비즈니스 규칙)

- 같은 회원이 같은 수업을 중복 예약 불가 (`reservations` 유니크 인덱스, `status in ('confirmed','waitlisted')` 대상)
- 수강권 잔여횟수는 DB 제약으로 음수 불가 (`memberships_remaining_not_negative`)
- 수강권은 횟수권(`count`)/기간권(`period`) 두 가지, 기간권은 자동연장(`auto_renew`) 가능
- 예약/취소 가능 시간, 당일 예약 변경, 폐강 시간, 대기 자동승격, 일일 예약 횟수 제한 등은 센터별로 `center_settings`에서 설정
- 결제는 분할결제 가능(카드+현금+계좌이체+포인트 합산이 `total_amount`), 미수금(`unpaid_amount`)과 위약금(`penalty_amount`) 별도 관리
- 매출 구분(신규/재결제/체험/업그레이드/환불/미수금결제/양도수수료)과 매출 종류(수강권/수업/기타)를 구분해 집계
- 결제 상태는 `pending`/`paid`/`refunded`/`failed` — 가상계좌(무통장) 결제 필드(`virtual_account_*`)가 스키마에 존재하나, 실제 PG 연동이 없으므로 현재는 매니저가 수기로 상태를 갱신하는 흐름으로 보임
