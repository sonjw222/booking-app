# ROUTES

> `app/` 디렉토리(App Router)의 모든 `page.tsx` 기준. 각 파일 상단 주석에서 역할 설명을 인용했습니다.
> Next.js 미들웨어/서버 가드는 없으며(`app/layout.tsx`에 인증 체크 없음 — 직접 확인), 접근 통제는 아래 두 계층으로만 이뤄집니다:
> 1. **페이지 컴포넌트 내부의 클라이언트 체크** (`checkPlatformAdmin()`, `fetchMyCenters()` 등) — 있는 페이지도, 없는 페이지도 있습니다(아래 표에 확인된 대로 표시).
> 2. **Supabase RLS** — 최종 방어선. 클라이언트 체크가 없어도 실제 데이터 read/write는 RLS로 막힙니다.
>
> ⚠ **로그인 필요 표시에 대한 정정**: 회원 전용 페이지(`/mypage`, `/reservation`, `/profiles` 등)는 **라우트 자체가 `/login`으로 리다이렉트하지 않습니다.**
> 비로그인 상태로 접속하면 페이지 셸은 그대로 렌더링되고, 데이터 조회 함수가 `throw new Error("로그인이 필요해요")`를 던져
> 화면에 에러 토스트만 표시되는 방식입니다(예: `lib/mypage.ts:45`, `app/profiles/page.tsx`의 `catch (e: any) { setError(e.message) }` 패턴).
> 아래 "로그인 필요"는 이 방식(에러 토스트)을 의미하며, 라우트 레벨 강제 이동이 있다는 뜻이 아닙니다.

## 범례
- 👤 일반 회원(고객) 화면 — 로그인 필요(리다이렉트 아님, 위 정정 참고)
- 🧑‍💼 매니저(센터 운영) 화면 — `manager_centers` 소속 필요, 세부 권한은 `permissions` 카탈로그로 제어
- 🛡 플랫폼 운영자 화면 — `is_platform_admin = true` 필요. **단, 페이지별로 실제 클라이언트 가드 여부가 다릅니다** — 4절 참고
- 🌐 로그인 불필요(공개)

## 1. 공개 / 회원 공용

| URL | 역할 |
|---|---|
| `/` | 🌐 홈. 제휴 센터·예약 가능 클래스를 DB에서 조회, 카테고리·검색 진입점 |
| `/search` | 🌐 센터명/종목 검색 |
| `/category/[label]` | 🌐 종목별 센터 목록 |
| `/center/[id]` | 🌐 센터 상세(소개/주소/연락처/수업 목록/후기). 승인된 센터만 노출 |
| `/login` | 🌐 로그인/회원가입 (회원·매니저 역할 선택, 매니저는 센터 정보 추가 입력) |

## 2. 회원(고객) 전용 👤

| URL | 역할 |
|---|---|
| `/reservation` | 예약 캘린더. 수업 예약/취소가 DB에 실시간 반영 |
| `/my-reservations` | 내 예약 목록(하단 네비 탭) + 캘린더 바로가기 |
| `/cart` | 장바구니. 수강권/상품 담기, 쿠폰, 결제수단 확인 |
| `/checkout` | 결제(주문서) 화면. 실제 결제 연동 전이며 주문을 `pending`으로 생성 |
| `/purchases` | 구매 내역, 24시간 이내·미사용 건 환불 요청 |
| `/mypage` | 마이페이지 홈: 프로필, 수강권 현황(잔여횟수/유효기간), 예약내역, 로그아웃 |
| `/mypage/calendar` | 마이페이지 - 풀스크린 예약 캘린더(프로필별 색상) |
| `/mypage/history` | 날짜별 전체 예약 이력(상태 필터) |
| `/profiles` | 프로필(수강 주체) 관리 — 추가/삭제, 대표 프로필은 삭제 불가 |
| `/notifications` | 회원 알림함(공지/예약 임박/수강권 만료 등) |
| `/inquiries` | 1:1 문의 — 문의방 목록, 신규 문의 생성, 실시간 채팅 |
| `/settings/notifications` | 알림 on/off 설정(기기 로컬 저장, 실제 발송 연동 없음) |
| `/settings/theme` | 테마(버건디/네이비/세이지/차콜) 선택 |

## 3. 매니저(센터 운영) 전용 🧑‍💼 — `/manager/*`

> **접근 통제 재검증 결과**: 19개 페이지 중 16개는 `fetchMyCenters()`로 "내가 이 센터의 매니저인지"를 클라이언트에서 확인합니다.
> `/manager/inquiries`, `/manager/notifications`, `/manager/staff/permissions` 3개는 이 클라이언트 체크가 없고 RLS에만 의존합니다(확인됨).
>
> 아래 표의 "(◯◯ 권한)" 표기는 각 페이지 파일 상단 주석에 적힌 설명을 그대로 인용한 것입니다. **재검증 결과, 이 페이지들의 실제 컴포넌트 코드에는
> 권한을 확인해 버튼/메뉴를 숨기거나 비활성화하는 로직이 없습니다** (`effectiveState()` 등 `lib/roles.ts`의 권한 판정 함수는 `/manager/staff/permissions`
> 화면 — 권한을 "설정"하는 화면 — 한 곳에서만 사용되고, 권한을 "적용/제한"하는 용도로는 다른 어떤 페이지에서도 쓰이지 않습니다).
> 즉, 로그인한 매니저/스태프는 자신에게 부여된 권한과 무관하게 `/manager/*`의 모든 화면과 버튼을 볼 수 있습니다.
> 다만 실제 쓰기 동작은 `has_permission()` DB 함수가 RLS/RPC 단에서 광범위하게 확인하므로(`reservation_functions.sql` 등에서 40회 이상 사용, 직접 확인)
> 권한 없는 조작은 서버에서 최종적으로 거부됩니다 — **UI가 막지 않을 뿐, 데이터 보호 자체는 되어 있습니다.**
> 사용자 입장에서는 버튼을 눌렀다가 실패 메시지를 받는 방식이라는 뜻이며, 이는 [TODO.md](./TODO.md)에 UX 개선 항목으로 반영했습니다.

| URL | 역할 |
|---|---|
| `/manager` | 매니저 대시보드 홈. 운영 센터 선택, 오늘 수업/예약 현황 요약 |
| `/manager/classes` | 수업 등록/수정/삭제, 스케줄 복사(요일/날짜 기준) |
| `/manager/rooms` | 룸(장소) 관리 |
| `/manager/membership-rules` | 수강권 상품 생성 + 요일/시간/수업명 예약조건 설정 |
| `/manager/members` | 회원 목록/검색/등급/메모/CSV 내보내기 |
| `/manager/progress` | 진도표 1단계: 기술 대분류/세부기술 관리 (`customer.progress` 권한) |
| `/manager/progress/record` | 진도표 2단계: 회원별 진도 기록 (`customer.progress` 권한) |
| `/manager/sales` | 매출 관리: 기간별 요약, 결제수단/매출구분 집계, 결제 등록 |
| `/manager/orders` | 회원 구매 주문 확인/발급 처리(주문은 pending으로 들어옴 — 결제 연동 없음) |
| `/manager/goods` | 상품(대여·물품) 관리, 무제한/횟수제한 옵션 |
| `/manager/reviews` | 자기 센터 후기 열람, 답변 작성/수정, 악성 후기 삭제 |
| `/manager/announcements` | 공지사항 작성(서식+사진), 발행 시 관련 회원 전원에게 알림 |
| `/manager/inquiries` | 자기 센터로 온 1:1 문의 응대 — ⚠ `fetchMyCenters()` 클라이언트 체크 없음(확인됨) |
| `/manager/notifications` | 매니저 알림함(신규 구매/후기/예약·취소 등) — ⚠ `fetchMyCenters()` 클라이언트 체크 없음(확인됨) |
| `/manager/holidays` | 휴무일 등록/삭제 |
| `/manager/center-info` | 센터 소개글/주소/연락처 편집 (`facility.info` 권한) |
| `/manager/settings` | 센터 운영 설정 17항목(예약/취소 시간, 폐강, 대기 등) (`facility.operation` 권한 또는 오너) |
| `/manager/staff` | 스태프 초대/역할변경/삭제 + 역할별 권한 설정 |
| `/manager/staff/permissions` | 특정 스태프의 개인별 권한 오버라이드(역할따름/허용/차단) — 오너 전용 (`facility.role_permission`) — ⚠ `fetchMyCenters()` 클라이언트 체크 없음(확인됨) |

## 4. 플랫폼 운영자 전용 🛡 — `/admin/*`

| URL | 역할 | 클라이언트 가드 확인 결과 |
|---|---|---|
| `/admin` | 운영자 설정 허브(하위 메뉴 진입) | ✅ `checkPlatformAdmin()` 호출, 실패 시 "운영자만 접근할 수 있어요" 표시하고 콘텐츠 미노출 |
| `/admin/centers` | 센터 가입 승인 관리(대기/승인/반려 탭, 사업자정보 확인, 반려 사유 입력) | ✅ `checkPlatformAdmin()` 호출, 동일하게 차단 |
| `/admin/categories` | 홈 노출 종목(카테고리) 추가/삭제 | ⚠ **확인됨 — 클라이언트 가드 없음.** `app/admin/categories/page.tsx`에 `checkPlatformAdmin()` 호출이 없어, 비운영자도 URL로 직접 접속하면 목록/입력폼이 그대로 보입니다. |
| `/admin/banners` | 홈 배너 추가/삭제/노출 순서 관리 | ⚠ **확인됨 — 클라이언트 가드 없음.** 위와 동일한 상태입니다. |

> **실제 위험도**: 데이터 유출/변조 자체는 발생하지 않습니다 — `service_categories`/`home_banners`는 `add_operator_settings.sql`에서
> SELECT를 `using (true)`(전체 공개)로, 쓰기는 `is_platform_admin()` 조건으로 RLS가 걸려 있어(직접 확인)
> 비운영자가 추가/삭제를 시도해도 Supabase가 최종적으로 거부합니다. 다만 화면 자체가 노출되고 저장 시도 시
> 사용자 친화적이지 않은 원본 에러 메시지가 뜰 수 있어 UX상 결함입니다 — [TODO.md](./TODO.md)에 반영.

## 5. 라우트 요약 통계

- 전체 페이지: 41개 (`page.tsx` 기준)
- 회원(공개 포함): 17개
- 매니저: 19개
- 플랫폼 운영자: 4개
- 동적 라우트(`[param]`): `/category/[label]`, `/center/[id]` — 두 곳만 Next.js가 서버 렌더링 대상(ƒ)으로 표시하고, 나머지는 정적 프리렌더(○)됨(`npm run build` 출력 기준)
