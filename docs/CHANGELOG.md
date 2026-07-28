# CHANGELOG

이 저장소의 Git 이력은 2026-07-26 `Initial commit` 한 번에 현재까지의 모든 기능이 통째로 들어왔기 때문에
(개발 자체는 그 이전부터 zip 파일 전달 방식으로 진행됨 — `SETUP_INSTRUCTIONS.md` 참고),
**Git 커밋만으로는 기능별 변경 이력을 알 수 없습니다**.

아래는 두 가지 근거를 함께 사용해 재구성한 변경 이력입니다.
1. **Git 커밋 로그** (2026-07-26 이후, 실제 날짜 있음)
2. **SQL 마이그레이션 파일 + `TEST_CHECKLIST*.md` 문서**에 남아 있는 롤아웃 순서 (날짜 없음, 상대적 순서만 확인 가능)

## Git 커밋 이력 (실제 날짜 확인됨)

| 날짜 | 커밋 | 내용 |
|---|---|---|
| 2026-07-28 | (커밋 전) | 위 UX 개선 후속 조정 3건. ① 사용 가능한 수강권이 여러 개일 때 기본 선택 로직을 "만료일이 가장 가까운 것 → 같으면 잔여횟수가 가장 적은 것 → 그 외엔 조회된 순서 유지"로 변경(`pickDefaultMembership()`, `usable_memberships_for_classes()`가 원래 정렬 없이 반환하던 것을 클라이언트에서 정렬 — 여전히 사용자가 직접 다른 수강권을 고를 수 있음). ② 결제 완료 후 자동 복귀 토스트를 "그 수업에 지금 바로 쓸 수 있는 수강권이 생겼는지"에 따라 두 문구로 분기(즉시 가능/발급 대기) — 이 시스템은 결제 즉시가 아니라 매니저 승인 후 수강권이 발급되므로, 배치 조회가 끝나고 모달이 그 수업으로 맞춰진 뒤 판단하도록 함. ③ `graphify update .` 실행해 그래프 최신화(1098 nodes, 2020 edges, 112 communities). 변경 파일: `app/reservation/page.tsx` |
| 2026-07-28 | (커밋 전) | 예약 → 수강권 구매 → 결제 흐름 UX 개선(로직 변경 없음). ① 구매 가능 수강권 조회를 모달을 열 때가 아니라 그 날짜의 수업 목록을 불러올 때 배치로 미리 가져오도록 변경(사용 가능한 수강권이 있는 수업은 애초에 조회 대상에서 제외해 호출도 줄임) — 모달을 열 때 대부분 로딩 없이 바로 보임. ② 센터 상세 구매 시트에 "전체 상품 보기" ↔ "이 수업에 맞는 수강권 보기" 토글과 현재 필터 상태 안내 추가. ③ 예약 모달에서 "수강권 구매하기"로 넘어간 뒤 센터/결제 화면의 뒤로가기(‹)가 무조건 홈으로 가던 것을 고쳐, 예약 화면에서 들어온 경우 그 수업 모달·날짜·센터 필터가 복원된 예약 화면으로 돌아가게 함(공용 URL 규칙 `lib/reservationNav.ts` 신설). ④ 결제 완료(주문 접수) 후 짧은 안내와 함께 자동으로 그 예약 화면으로 돌아가고(1.8초 후, 즉시 이동 버튼도 유지), 돌아오면 보유 수강권을 다시 조회하며 "✅ 수강권 구매가 완료됐어요" 토스트 표시. 새로 산 수강권이 그 사이 발급되어 있다면(현재는 매니저가 주문을 수동 확인해야 발급됨 — TODO 15) 기존 로직대로 자동으로 첫 번째 사용 가능한 수강권으로 선택됨. 변경 파일: `app/reservation/page.tsx`, `app/center/[id]/page.tsx`, `app/checkout/page.tsx`, `lib/reservationNav.ts`(신규), `app/globals.css` |
| 2026-07-28 | (커밋 전) | 예약 확인 모달에서 "사용 가능한 수강권이 없을 때" 안내 개선 — 단순 안내 문구 대신, 해당 수업의 `class_allowed_products` 기준으로 구매하면 이 수업에 쓸 수 있는 수강권 목록을 함께 보여줌(`fetchPurchasableProductsByClass` 신설, 이미 보유(active) 중인 상품은 목록에서 제외, 판매중지/비활성화 상품·다른 센터 상품 제외). 조회는 모달이 "사용 가능한 수강권 없음" 상태일 때만 지연 실행되며, 기존 수강권 배치 조회와 동일한 요청 토큰 패턴으로 수업을 빠르게 전환해도 이전 수업의 결과가 섞이지 않도록 함. "수강권 구매하기" 버튼은 이 상품 id 목록을 `?productIds=`로 센터 상세 구매 화면에 전달하고, 구매 화면은 해당 id로 상품 목록을 필터링(전체 상품 보기로 해제 가능) |
| 2026-07-28 | (커밋 전) | 예약창 수강권 표시/조회 개선 — 수업 목록에 "사용 가능: 상품명" 표시 추가(`usable_memberships_for_classes` 배치 RPC 신설, N+1 방지), 수업 전환 시 이전 수업의 수강권 목록이 잠깐 보이던 문제(상태 미초기화 + await 순서 + 레이스 컨디션) 수정 — 요청 토큰으로 오래된 응답 무시. `usable_memberships`/`reserve_with_membership`가 두 마이그레이션 파일(`add_pass_binding.sql` 귀속 방식 vs `add_shared_passes.sql` 공유 방식)에서 서로 다르게 정의돼 있던 것을 공유 방식으로 통일(`fix_usable_memberships_shared.sql`, Supabase에서 직접 실행 필요). 이어서 보유 상품(goods) 조회도 동일한 방식으로 정리 — 센터별 배치 조회(`fetchMyGoodsByCenter`, N+1 방지)로 바꿔 수강권과 같은 레이스 컨디션 없는 UX로 통일 |
| 2026-07-27 | `155fda1` | Fix sales product type error — `app/manager/sales/page.tsx`의 state 타입에 `kind`/`unlimited` 필드 누락으로 인한 빌드 실패 수정, `my-reservations` 페이지의 존재하지 않는 status 비교 제거, `useSearchParams()` 5개 페이지에 `Suspense` 경계 추가(Next.js 16 프리렌더 요구사항) |
| 2026-07-27 | `d5493d3` | Add package lock file |
| 2026-07-26 | `abd3b96` | Initial commit — 아래 "커밋 이전 기능 롤아웃"에 정리된 기능이 모두 포함된 최초 스냅샷 |

## 커밋 이전 기능 롤아웃 (SQL/체크리스트 근거, 상대적 순서)

`TEST_CHECKLIST*.md`에 남은 세션별 안내와 `schema.sql`/`add_*.sql`/`fix_*.sql` 파일명을 근거로 재구성한
개발 진행 순서입니다(정확한 날짜는 알 수 없음, 오래된 것부터).

### 1단계 — 기반 스키마
- 3계층 계정 구조 설계: `accounts`(로그인) → `profiles`(회원 프로필) / `manager_centers`(운영 소속)
- 센터, 수업(`classes`), 수강권(`memberships`), 예약(`reservations`), 결제(`payments`) 등 핵심 테이블 (`schema.sql`)
- 예약 처리 함수 및 관련 RLS 96개 정책 (`reservation_functions.sql`)
- 회원가입 RLS 오픈 (`auth_policies.sql`)

### 2단계 — 운영 기능 확장
- 룸/수업구분/운영설정(17항목) 도입, 결제수단 지정, 당일예약 설정
- 상품 체계 개편(수강권/굿즈 분리), 수업별 예약가능 수강권 제한
- 스태프 & 권한 관리(역할, 권한 카탈로그, 개인별 권한 예외) 도입
- 회원관리(등급/상태/메모/주소), 진도표(1단계 기술목록 → 2단계 기록)
  - `lockers`/`locker_assignments`(락커)는 `schema.sql`의 최초 설계에 테이블만 포함되었고, 재검증 결과 실제 화면/코드는 없는 것으로 확인됐습니다(확인됨, [DATABASE.md](./DATABASE.md) 1-8절) — "커밋 이전 롤아웃"이 아니라 "설계됐지만 만들어지지 않은 기능"입니다
- 반복수업 그룹, 스케줄 복사(요일 기준/날짜 기준, 달력 미리보기) — `TEST_CHECKLIST_4.md` "A. 스케줄 복사" 항목

### 3단계 — 커머스/커뮤니케이션 확장
- 매출 관리(분할결제, 지출, 매출구분), 포인트 적립/사용
- 주문(`orders`)/장바구니/구매내역/환불 플로우 (실제 PG 미연동 — 매니저 수기 확인)
- 요일반 수강권 자동예약(`add_auto_booking.sql`) 및 하루 1회 제한 보정(`fix_auto_book_oneperday.sql`)
- 프로필 간 수강권 공유(`add_shared_passes.sql`) — `TEST_CHECKLIST_4.md` "B. 프로필 간 수강권 공유 ★신규"
- 미배치 수강권 관리 + 주문 발급 자동화(`add_unplaced_passes.sql`, `add_order_fulfillment.sql`)
- 후기(별점/사진) + 후기 기반 포인트, 센터 답변 (`add_reviews_points.sql`, `add_review_reply.sql`)
- 후기 테이블 명칭 충돌 긴급 수정(`fix_center_reviews.sql`)
- 공지사항(서식+사진), 1:1 문의 채팅, 알림 시스템(실시간 팝업 + 알림함), 예약/취소 관련 알림 트리거
- 플랫폼 운영자(센터 승인) 기능 도입 (`add_platform_admin.sql`)

### 반복적으로 발생한 RLS 버그 수정 (운영 중 발견)
다음은 실제 사용 중 발견되어 별도 `fix_*.sql`로 패치된 회귀 버그들입니다. 향후 관련 테이블 작업 시 참고:
- 프로필 조회 불가("프로필을 찾을 수 없어요") — `fix_profile_rls_restore.sql`, `fix_missing_primary_profile.sql`
- RLS `with check` 누락으로 쓰기 정책이 의도대로 동작하지 않음 — `fix_rls_policies.sql`
- 수강권 발급/회원 추가 시 RLS 차단 — `fix_membership_rls.sql`
- 스태프 검색 시 `accounts` 조회 정책 무한 재귀 — `fix_staff_search.sql`
- 예약자 명단 미노출 — `add_roster_rls.sql`
- 대기자 자동 승격 오류(v2 패치) — `fix_waitlist.sql`
- 수업 삭제 시 취소 예약 처리/오너 권한 문제 — `fix_class_delete.sql`
- 회원 만료/휴면 처리 권한 — `fix_member_status.sql`

## 참고
- 위 "커밋 이전" 항목은 상대적 순서 추정치이며, 정확한 완료일이 필요하면 SQL을 실제로 Supabase에 적용한 시점을 팀 내에서 별도로 기록해야 합니다.
- 앞으로는 [DEVELOPMENT_RULES.md](./DEVELOPMENT_RULES.md)의 "기능별 작은 커밋" 규칙에 따라 Git 커밋 로그 자체가 신뢰할 수 있는 변경 이력이 되도록 합니다.
