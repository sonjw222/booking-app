# TODO

> 코드(`app/`, `lib/`, `*.sql`)를 분석해 확인한 미완성 기능/버그 가능성을 중요도 순으로 정리했습니다.
> "확인됨"은 코드/문구로 직접 근거를 찾은 항목, "가능성"은 구조상 추정되는 위험입니다.
> 실제 우선순위는 비즈니스 판단(사용자 규모, 출시 일정)에 따라 조정하세요.

## P0 — 서비스 핵심 기능 관련 (출시/매출에 직접 영향)

1. **실제 결제(PG) 연동 없음 [확인됨]**
   `app/checkout/page.tsx`, `app/cart/page.tsx`에서 "결제하기"를 눌러도 카드/간편결제가 처리되지 않고
   `orders` 테이블에 `pending` 상태로만 기록됩니다. 매니저가 `/manager/orders`에서 수동으로 확인·발급해야 합니다.
   실서비스로 운영하려면 PG(토스페이먼츠/아임포트 등) 연동이 필수입니다.
   → 관련: `lib/orders.ts`, `payments.pg_transaction_id`/`virtual_account_*` 컬럼(스키마엔 이미 자리만 있음)

2. **정기 알림 스케줄러 미설정 [확인됨]**
   예약 3일전/당일 알림, 수강권 만료·소진 알림 DB 함수(`notify_upcoming_reservations`, `notify_expiring_passes`)는
   존재하지만 이를 매일 호출하는 스케줄러(Supabase pg_cron 등)가 앱/저장소 어디에도 설정되어 있지 않습니다(`README.md` 5절 — "선택" 항목으로만 안내됨).
   설정하지 않으면 알림이 영구히 발송되지 않습니다.

3. **Row Level Security 회귀 이력이 많음 [확인됨 — 재발 위험]**
   `fix_profile_rls_restore.sql`, `fix_rls_policies.sql`, `fix_membership_rls.sql`, `fix_staff_search.sql`,
   `add_roster_rls.sql` 등 최소 5건의 "긴급 복구"성 RLS 패치 이력이 있습니다. API 서버 없이 RLS만으로 접근을 통제하는 구조라
   RLS 정책을 건드리는 모든 변경은 회귀 가능성이 높습니다. 회귀 테스트 체크리스트나 자동화된 RLS 테스트가 없어
   같은 유형의 버그가 다시 발생할 위험이 구조적으로 남아 있습니다.

## P1 — 사용자에게 노출되는 미구현/제한 기능

4. **네이버 소셜 로그인 미구현 [확인됨]**
   `app/login/page.tsx:237`에서 네이버 버튼 클릭 시 "로그인 설정이 아직 안 되어 있어요" 메시지만 표시.
   카카오/애플은 Supabase Provider 설정만 하면 동작하지만 네이버는 Supabase 기본 미지원으로 별도 Edge Function이 필요(`AUTH_SETUP.md` 3-3절).

5. **푸시/알림톡 실제 발송 미구현 [확인됨]**
   `/settings/notifications`의 on/off 설정은 기기 로컬 저장만 하며, 실제 SMS/푸시 발송 연동은 없습니다(`app/settings/notifications/page.tsx:6`).
   `messages` 테이블(발송 기록용)은 스키마에 있으나 실제 발송기(SMS 게이트웨이/FCM 등) 연동 코드는 없습니다.

6. **앱 내 환불이 제한적 [확인됨]**
   `/purchases`에서 "미발급 주문"은 앱에서 취소 불가하고 센터 문의로 안내됩니다(`app/purchases/page.tsx:49`).
   발급 후 24시간 이내·미사용 건만 환불 버튼이 노출되는 등 환불 정책이 하드코딩되어 있어, 정책 변경 시 코드 수정이 필요합니다.

## P2 — 데이터 정합성 / 유지보수성 위험 (가능성)

7. **국경일(공휴일) 목록이 하드코딩됨 [확인됨]**
   `app/reservation/page.tsx:33`: `PUBLIC_HOLIDAYS`가 `{ "2026-07-17": "제헌절" }` 단 하나만 들어 있고,
   주석에 "나중에 공휴일 API 또는 테이블로 교체 가능"이라고 명시되어 있습니다.
   현재 상태로는 2026-07-17 이후 국경일이 캘린더에 전혀 표시되지 않습니다. (센터별 휴무일인 `center_holidays`와는 별개 문제)

8. **스키마에는 있으나 앱 코드에서 전혀 쓰이지 않는 테이블이 27개 확인됨 [확인됨]**
   `lib/*.ts` 전체에서 `.from()` 호출을 검색한 결과, `reviews`(→`center_reviews`로 대체됨), `class_trainers`(수업별 복수 강사 배정),
   `class_types`(수업 구분), `lockers`/`locker_assignments`(락커), `membership_transfers`(수강권 양도), `chat_messages`,
   `community_posts`/`community_comments`, `competitions`, `leads`, `staff_salaries`/`staff_schedules`, `contract_templates`/`terms`/`contracts` 등
   27개 테이블이 어느 화면에서도 조회/변경되지 않습니다. 전체 목록과 근거는 [DATABASE.md](./DATABASE.md) 1-8절.
   일부(급여/계약서/상담고객)는 `permissions` 카탈로그에 권한 키까지 정의되어 있어 "화면만 아직 안 만든 로드맵 기능"으로 보이고,
   일부(`reviews`, `chat_messages`)는 다른 테이블로 대체된 "죽은 스키마"로 보입니다 — 코드만으로는 구분할 수 없어 확인이 필요합니다.
   → 실제 사용 계획이 없다면 정리하고, 있다면 로드맵 문서에 반영해 향후 작업자의 혼동을 줄이는 것을 권장합니다.

9. **포인트 시스템이 두 테이블로 이원화되어 있음 [확인됨]**
   매출/결제 화면(`app/manager/sales`, `lib/sales.ts`)은 `point_transactions` 테이블을 사용하고,
   후기 작성 시 포인트 적립·잔액 조회(`lib/reviews.ts`)는 `point_accounts`(+`point_logs`, 이쪽은 미사용) 테이블을 사용합니다.
   두 시스템이 하나의 회원 포인트 잔액을 공유하는 구조인지, 서로 다른 시점에 만들어진 별개의 포인트 시스템인지 코드로는 판단할 수 없었습니다.
   회원이 실제로 보는 포인트 잔액 계산 로직을 반드시 재확인하세요 — 잘못 나뉘어 있다면 "매출에서 차감했는데 후기 화면 잔액은 그대로"같은
   정합성 버그로 이어질 수 있습니다. → [DATABASE.md](./DATABASE.md) 1-3절.

10. **`.env.local.example` 파일 부재 [확인됨]**
   `README.md`가 `cp .env.local.example .env.local`을 안내하지만 저장소에 해당 파일이 없어 새로 합류하는 사람/도구가
   README를 그대로 따라 하면 실패합니다.

11. **TypeScript `any` 사용 약 243곳 [확인됨]**
    대부분 `catch (e: any)` 패턴(54개 파일). [DEVELOPMENT_RULES.md](./DEVELOPMENT_RULES.md) 규칙 도입 이전 코드이며
    당장 빌드를 막지는 않지만, 에러 객체의 실제 타입을 좁히지 않아 잘못된 필드 접근을 컴파일 타임에 잡지 못합니다.

12. **전역 인증/권한 가드 부재, 그리고 실제로 가드가 빠진 페이지가 이미 존재함 [확인됨]**
    `app/layout.tsx`에는 인증 체크가 없고, 각 매니저/관리자 페이지가 개별적으로 `fetchMyCenters()`/`checkPlatformAdmin()`을 호출해
    권한을 확인하는 구조입니다. 실제로 코드 전체를 검사한 결과, 이 체크가 빠진 페이지를 확인했습니다:
    - `/admin/categories`, `/admin/banners` — `checkPlatformAdmin()` 호출 없음. 비운영자도 URL로 직접 접속하면 관리 화면이 그대로 보입니다.
      (`service_categories`/`home_banners`의 쓰기는 RLS(`is_platform_admin()`)로 막혀 있어 데이터 유출/변조는 없음 — [ROUTES.md](./ROUTES.md) 4절)
    - `/manager/inquiries`, `/manager/notifications`, `/manager/staff/permissions` — `fetchMyCenters()` 호출 없음(RLS에만 의존)
    - **세분화된 매니저 권한(`permissions`/`role_permissions`)은 어느 화면에서도 버튼/메뉴를 숨기거나 비활성화하는 데 쓰이지 않습니다.**
      권한 판정 함수(`effectiveState()`)는 권한을 "설정"하는 `/manager/staff/permissions` 화면에서만 쓰이고, 실제 기능 화면들은
      로그인한 사람의 권한과 무관하게 동일한 UI를 보여줍니다. 서버(`has_permission()` DB 함수)가 최종적으로 막아주므로 데이터는 안전하지만,
      권한 없는 스태프가 할 수 없는 작업의 버튼을 눌러보고서야 실패를 알게 되는 UX입니다 — [REQUIREMENTS.md](./REQUIREMENTS.md) "권한/역할" 절 참고.
    → 새 매니저/관리자 페이지를 추가할 때 이 체크를 빠뜨리기 쉬운 구조이므로, 페이지 템플릿화(공용 가드 컴포넌트/훅) 또는 최소한 체크리스트화를 권장합니다.

13. **60개 이상의 SQL 마이그레이션을 수동 순서 실행 (가능성)**
    마이그레이션 도구 없이 Supabase SQL Editor에 파일을 순서대로 붙여넣는 방식이라, 새 환경 구축 시 순서를 하나라도
    빠뜨리면 이후 파일이 참조하는 테이블/함수가 없어 실패할 수 있습니다. `README.md`가 일부 순서(공지→알림→알림트리거→문의)만
    명시하고 전체 60여 개 파일의 완전한 순서는 문서화되어 있지 않습니다. → [DATABASE.md](./DATABASE.md) 5절에 실행 순서를 정리해두었으니 갱신 시 참고.

## P3 — 참고/모니터링 필요 (긴급하지 않음)

14. **매니저 대시보드 일부 메뉴 미연동 가능성**
    `app/manager/page.tsx` 주석: "관리 메뉴: 수업/수강권조건/진도표/회원 (일부는 다음 단계에서 실연동)" — 이 주석이
    최신 상태를 반영하는지 재검증 필요(작성 시점과 현재 구현 상태가 다를 수 있음).

15. **Tailwind가 설치·설정만 되어 있고 실제로는 적용되지 않음 [확인됨]**
    `package.json`에 `tailwindcss`, `@tailwindcss/postcss`가 있고 `postcss.config.mjs`도 이를 플러그인으로 등록했지만,
    프로젝트의 유일한 CSS 파일인 `app/globals.css`에 `@import "tailwindcss"`/`@tailwind` 지시문이 전혀 없어 Tailwind 유틸리티 CSS가 생성되지 않습니다.
    그런데 `app/layout.tsx:30`은 `className="min-h-full flex flex-col"`처럼 Tailwind 유틸리티 클래스를 사용하고 있어,
    **이 클래스들은 스타일이 적용되지 않는 죽은 클래스일 가능성이 높습니다**(`create-next-app` 스캐폴드 잔재로 추정 — `SETUP_INSTRUCTIONS.md`는
    애초에 "Tailwind CSS: No"로 프로젝트를 만들라고 안내했습니다). 실제 렌더링에 문제가 없다면 CSS 상속/기본 스타일로 우연히 비슷하게 보이는 것일 수 있으니,
    브라우저에서 `body`의 실제 적용 스타일을 확인하고 Tailwind 의존성 제거 또는 정상 연동 중 하나로 정리하는 것을 권장합니다.

---

### 우선순위 판단 기준
- **P0**: 사용자가 돈을 내거나 알림을 받는 핵심 흐름이 실제로 동작하지 않음 / 보안(RLS) 회귀 위험
- **P1**: 사용자에게 "미구현" 상태가 노출되지만 안내 문구로 처리되어 있어 당장 오류는 아님
- **P2**: 방치 시 데이터 혼란이나 협업 오류로 이어질 수 있는 유지보수성 문제
- **P3**: 재검증이 필요한 불확실한 항목
