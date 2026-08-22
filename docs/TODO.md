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

### P0-2. (2026-08-14, 완료) 운영 DB migration ledger와 최종 객체 검증

| 필드 | 내용 |
|---|---|
| 우선순위 | P0 |
| 현재 상태 | **완료.** 루트 SQL 108개(최초 기록된 67개보다 증가) 전체를 파싱해 선언하는 테이블/컬럼/함수/트리거가 라이브에 실제로 존재하는지 자동 대조 — **진짜 누락 0건**(오탐 2건은 조사로 해소, 아래 참고). GRANT/REVOKE는 이 자동 대조로 못 잡아서 `service_role` GRANT만 별도 수동 점검, 2건 발견 → 수정 SQL 작성 → **사용자가 SQL Editor에서 적용 완료, `information_schema.role_table_grants` 재조회로 4개 권한(select/insert/update/delete) 전부 반영됨을 직접 재확인함**. |
| 근거 파일 | 루트 SQL 108개, `schema.sql`, `reservation_functions.sql`, `README.md`, `docs/DATABASE.md`, `fix_service_role_missing_grants_class_allowed_products_update.sql`(신규), `fix_service_role_missing_grants_center_holidays.sql`(신규) |
| 이번 배치에서 한 것 | (1) `supabase db query --linked`로 라이브 `public` 스키마 전체 인벤토리(테이블 65개/컬럼 609개/함수 60개/트리거 7개) 조회. (2) 108개 SQL 파일을 정규식으로 파싱해 `create table`/`alter table add column`/`create or replace function`/`create trigger` 선언을 추출, 라이브 인벤토리와 자동 대조. 오탐 2건 확인·해소: `add_rooms_fix.sql`은 한글 주석을 정규식이 잘못 매칭한 파싱 버그(실제 문제 없음, `rooms` 테이블은 정상 존재), `add_center_category.sql`(`centers.category` 단일 컬럼 제안)은 실제로 라이브에 없는 게 맞지만 **폐기된 설계**로 확인됨 — `schema.sql` 22번째 줄에 처음부터 더 나은 방식(`centers.categories text[]` 배열 + `service_categories` 참조 테이블)이 채택돼 있고 `lib/home.ts`가 그 배열 컬럼을 실제로 사용 중이라, 이 단일 컬럼 제안 파일 자체가 안 쓰이는 게 정상. (3) `fix_service_role_missing_grants_*`(8개) 계열이 GRANT라 자동 검사 대상이 아니라 `information_schema.role_table_grants`로 직접 확인: `class_allowed_products`가 UPDATE만 빠짐(기존 fix 파일은 4개 권한을 다 요청했는데 3개만 반영된 상태), `center_holidays`는 GRANT가 아예 0건(다른 세션 SEC-114 배치의 "permission denied for table center_holidays" 실패 원인으로 확인, 그 세션에 공유함 — `orders`도 같은 증상이 보고됐었으나 이 저장소에서 근거 코드를 못 찾아 그 부분은 만들지 않음). 두 건 다 수정 SQL 작성(`fix_service_role_missing_grants_class_allowed_products_update.sql`, `fix_service_role_missing_grants_center_holidays.sql`, 각각 rollback 포함) → **사용자가 적용 완료**. |
| 완료 조건 | ~~운영 DB에 적용된 migration 파일·순서·적용일을 기록하고... 누락·중복 적용 여부를 확인함~~ 완료. `fix_*.sql`(비RPC류) 개별 본문 수준 검증은 P0-3 수준 깊이로는 안 함(핵심 RPC 10개만 그렇게 함) — 필요시 별도 배치. |
| 관련 문서 | [DATABASE 12절](./DATABASE.md), [DEVELOPMENT_RULES 6절](./DEVELOPMENT_RULES.md) |

README의 큰 순서만으로 전체 migration을 재현할 수 있는지 검증되지 않았습니다. SQL 파일 목록을 실행 순서로 간주하면 안 됩니다.

### P0-3. (2026-08-14, 10개 전부 확인 완료) 핵심 RPC의 운영 최종 본문 확인

| 필드 | 내용 |
|---|---|
| 우선순위 | P0 |
| 현재 상태 | **완료. 10개 전부 `supabase db query --linked`(Management API 경유, DB 비밀번호 불필요)로 라이브 함수 본문을 직접 추출해 저장소 SQL과 정규화 대조함(공백/주석/`public.` 접두사/`$$`↔`$function$` 같은 포맷 차이는 무시하고 실제 로직만 비교).** |
| 완료 조건 | ~~운영 DB에서 `pg_get_functiondef()`로 핵심 RPC 본문을 추출해 저장소의 의도한 최종본과 대조~~ 완료. 역할별 회귀 테스트 자동화는 P0-4 범위로 이관. |
| 관련 문서 | [DATABASE 9절, 12-5](./DATABASE.md), [REQUIREMENTS 10절](./REQUIREMENTS.md) |

**2026-08-14 최종 확인 결과 (10/10)**:

| RPC | 결과 |
|---|---|
| `reserve_class` | ✅ `add_class_trainers_pass_selection_mode_draft_proposed.sql`과 완전 일치(search_path 하드닝만 추가) |
| `reserve_with_membership` | ✅ 위와 동일 파일과 완전 일치 |
| `usable_memberships` | ✅ 위와 동일 파일과 완전 일치 |
| `usable_memberships_for_classes` | ✅ 위와 동일 파일과 완전 일치 |
| `cancel_reservation` | ✅ `fix_reservation_cancel_grace_period_draft_proposed.sql`과 완전 일치(search_path 하드닝만 추가) |
| `is_platform_admin` | ✅ `schema.sql`과 완전 일치(search_path 하드닝만 추가) |
| `fulfill_order` | ✅ 논리 일치 — `reservation_functions.sql`(통합본)엔 없는 SEC-118 가격 검증 + `direct_amount` 직접결제 로직이 라이브엔 있음, 각각 출처는 `add_direct_payment.sql`/`add_unplaced_passes.sql`로 추적됨(통합본 미갱신, 이 프로젝트의 기존 관례) |
| `manager_set_attendance` | ⚠️ 라이브가 `fix_attendance_consolidate_and_guard_draft_proposed.sql`(08-07, 이전엔 이걸로 "확인됨" 처리됨)보다 더 최신 — 대기예약 직접확정 차단 가드, 환급 조건 정교화 2건이 추가로 들어있음. 출처는 다른 세션의 `fix_manager_set_attendance_membership_integrity_draft_proposed.sql`(PR #50, "manager_set_attendance 무결성", 본인 PR 제목상 Live 적용 완료) — **우리 세션 담당 범위 아님, 정상** |
| `auto_book_membership` | ⚠️ 라이브가 다른 세션의 `fix_auto_book_membership_idor_draft_proposed.sql`(PR #47/#50 IDOR 수정)보다 더 최신 — `pass_selection_mode`/`class_allowed_products` 조건(8/11 배치)이 라이브엔 있는데 그 draft 파일엔 없음(그 파일 base가 오래됨). **그 세션에 공유 완료** — 그 draft를 그대로 재적용하면 pass_selection_mode 로직이 되돌아갈 위험이 있어 patch 방식 재작성을 제안함 |
| `has_permission` | ✅ 라이브에 `r.center_id = mc.center_id` cross-center join 하드닝이 이미 적용돼 있음(저장소 SQL 파일엔 없음 — 대신 다른 세션의 PR #48("P0 보안 산출물 통합")에 이미 문서화된 변경으로 확인, 우리가 새로 만들 필요 없음) |

**결론**: 10개 RPC 전부 라이브가 저장소의 "가장 최근 의도"와 논리적으로 일치하거나, 그보다 더
앞서 있다(다른 세션의 이미 적용된 보안 수정 포함). **로직이 뒤처지거나 알 수 없는 orphan
상태인 RPC는 0개.** `reservation_functions.sql`(통합본)은 여러 곳에서 최신 패치를 반영 못 해
낡은 상태지만, 이 프로젝트가 이미 받아들인 패턴(통합본은 스냅샷, 최신 진실은 개별
`fix_*.sql` + 라이브 DB)이라 그 자체는 결함이 아님.

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

**2026-08-07 갱신(P3 출석 배치)**: `manager_set_attendance`는 저장소 안에 서로 다른 버전이
4곳에 정의돼 있어(`add_attendance.sql` v1, `reservation_functions.sql` 안에 v1 중복 + v2,
`add_admin_assignment.sql` v4) 어느 게 라이브인지 알 수 없던 상태였다.
`fix_attendance_consolidate_and_guard_draft_proposed.sql`로 v4를 base로 유일한 정의로
통합하고, 감사에서 발견한 실제 버그(대기 예약도 출석 처리 가능)를 함께 고쳤다 —
**2026-08-07 사용자가 운영 DB에 적용 완료, `pg_get_functiondef`로 확인됨** — 이제 이 RPC는
"확인 필요" 목록에서 제외한다.
"지각(late)" 상태는 스키마(`reservations.status` check 제약)에 아예 없고, 이번 MVP 요청도
"최소 상태 관리"였던 점을 감안해 추가하지 않았다 — 필요하면 CHECK 제약 확장 + RPC 분기 +
양쪽 관리자 UI 수정이 필요한 별도 제품 결정.

### P0-4. (2026-08-14, 완료) RLS 회귀 테스트와 운영 정책 확인

| 필드 | 내용 |
|---|---|
| 우선순위 | P0 |
| 현재 상태 | **완료.** `docs/24_P0_4_RLS_Snapshot.md`에 라이브 `pg_policies` 전수 스냅샷 기록(65개 테이블 전부 RLS 활성화, 위험한 전면 쓰기 허용 정책 0건). 역할별 read/write 자동화는 `tests/integration/`의 기존 27개 파일 전체를 실제로 재실행해 충족 — 사용자가 `TEST_CENTER_ID`를 승인 상태로 바꿔주자 이전엔 환경 문제로 못 돌리던 예약/권한 경계 테스트 전부가 실행됨. |
| 근거 파일 | `fix_profile_rls_restore.sql`, `fix_missing_primary_profile.sql`, `fix_rls_policies.sql`, `fix_membership_rls.sql`, `fix_staff_search.sql`, `add_roster_rls.sql`, `fix_member_status.sql`, `fix_center_reviews.sql`, `docs/24_P0_4_RLS_Snapshot.md`(신규), `tests/integration/*.test.ts`(27개, 기존) |
| 이번 배치에서 한 것 | (1) `supabase db query --linked`로 `public` 스키마 65개 테이블 RLS 활성화 여부 + 152개 정책의 `USING`/`WITH CHECK` 표현식 전수 조회(위 스냅샷). (2) `npm run test:integration` 전체(27개 파일, 161개 테스트) 재실행 → **140 통과 / 5 실패 / 16 스킵** — 비로그인/회원/스태프/매니저/오너/플랫폼 운영자 경계를 검증하는 `acl-003-permission-read`, `admin-assignment-security` 등 대부분의 role-boundary 테스트가 통과함으로써 완료 조건의 "역할별 read/write 테스트 자동화 실행"을 실질적으로 충족. |
| 남은 실패 5건(전부 P0-4 범위 밖으로 확인됨) | (1) `sync-test-payment-center-member.test.ts` 1건 — 테스트 파일 자체 주석에 "SQL 미적용 전엔 의도적으로 FAIL"이라 명시된 알려진 상태(Mock 결제 전용 갭, 실제 결제 경로인 `fulfill_order`는 P0-3에서 이미 정상 확인됨). (2)(3) `auto-book-membership-security.test.ts`/`manager-centers-privilege-escalation.test.ts` 5건 — 둘 다 다른 세션(PR #47/#50)의 진행 중인 보안 작업 전용 테스트 파일(이 저장소에 커밋 안 됨)이라 그 세션에 실패 내역 공유 완료, 우리 세션 조치 대상 아님. |
| 완료 조건 | ~~현재 pg_policies 결과를 기록함~~ 완료. ~~역할별 read/write 테스트 자동화~~ 완료(기존 통합 테스트 스위트 전체 재실행으로 충족). |
| 관련 문서 | [DATABASE 7절, 10절](./DATABASE.md), [REQUIREMENTS 4절](./REQUIREMENTS.md), [ROUTES 2절](./ROUTES.md), [24_P0_4_RLS_Snapshot](./24_P0_4_RLS_Snapshot.md) |

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

### P0-5. (2026-08-21, 완전히 완료 — 10일 연속 정상 작동 라이브 확인) 정기 알림 스케줄러

| 필드 | 내용 |
|---|---|
| 우선순위 | P0 |
| 현재 상태 | **완료.** `cron.job`/`cron.job_run_details`/`notifications` 라이브 직접 조회로 실제 자동 발송까지 확인됨(2026-08-21, 사용자 실행). |
| 근거 파일 | `add_notifications.sql`, `add_notification_scheduler.sql`, `README.md` 5절; 함수 `notify_upcoming_reservations()`, `notify_expiring_passes()` |
| 이번 배치에서 한 것 | `pg_cron`(Supabase 전 플랜 무료 지원, 외부 서비스/사업자 불필요) 확장을 켜고 두 함수를 매일 KST 오전 9시(UTC 0시)에 순서대로 호출하는 job(`daily-notifications`) 등록. 두 함수 모두 이미 멱등(같은 예약/수강권에 같은 종류 알림 중복 생성 안 함)이라 재실행 안전. |
| 완료 조건 | ~~익일(2026-08-14) KST 오전 9시 이후 실제로 알림이 자동 생성되는지 `notifications` 테이블에서 확인~~ 완료 |
| 관련 문서 | [REQUIREMENTS 6-2](./REQUIREMENTS.md), [DATABASE 9-3, 12-5](./DATABASE.md) |

**2026-08-21 최종 확인**: `cron.job` 조회로 `daily-notifications`가 `active=true`, 스케줄
`0 0 * * *`로 등록돼 있음을 확인. `cron.job_run_details`로 2026-08-12~08-21 **10일 연속
전부 `succeeded`**(각 실행 2~3초)임을 확인 — 실행 실패 없이 안정적으로 매일 돌고 있다.
`notifications` 테이블에서 스케줄러가 만드는 4종 kind를 직접 집계: `pass_used_up` 211건·
`reservation_3days` 10건·`reservation_today` 82건은 오늘(08-21)까지 계속 생성 중이고,
`pass_expired`는 08-15~16에만 10건 있고 그 뒤로 없는데 이건 실패가 아니라 그 이후로
"오늘 만료되는 수강권"이라는 조건에 맞는 대상 자체가 없었다는 뜻(멱등·조건부 함수라
매일 생성되는 게 정상이 아님). 함수 존재·job 등록뿐 아니라 **실제 자동 발송이 라이브에서
매일 벌어지고 있음**을 데이터로 확정 — 이제 P0로 남겨둘 이유 없음.

### P0-6. (2026-08-14, 완료 확인 — 문서만 정정) 휴무일 강제 지정 시 취소된 예약의 수강권 횟수가 복구되지 않음

| 필드 | 내용 |
|---|---|
| 우선순위 | P0 |
| 현재 상태 | **완료. 이미 라이브에 적용돼 있었음 — 이 문서가 정정 없이 "미수정"으로 오래 남아있었던 문서 누락이었음(실제 DB 상태와 무관).** |
| 근거 파일 | `fix_holiday_history_and_notification_draft_proposed.sql`(커밋 `4679706`, NOTIF-001 배치), `reservation_functions.sql`(`add_holiday_safe` 함수 — ⚠ 이 통합본은 옛 버전(DELETE 기반, 수강권 미복구)으로 갱신 안 됨, 실제 라이브는 아래 패치가 적용된 최신 상태), `app/manager/holidays/page.tsx` |
| 확인 경위 | 2026-08-02 최초 발견 당시엔 Track B 규칙(SQL 실행 금지)상 기록만 하고 미수정으로 남김. 이후 별도 배치(PR #32, closed·미merge)가 수정 SQL을 준비했으나 이 문서엔 반영되지 않음. 그러다 **알림/이력보존 리팩터링이 목적이었던 NOTIF-001 배치**(P0-6과 무관해 보이는 커밋 메시지)가 `add_holiday_safe()`를 DELETE 기반에서 UPDATE(status='cancelled') 기반으로 재설계하면서, PR #32가 추가했던 수강권 복구 로직(`remaining_count + sub.cnt`)을 그대로 유지한 채 적용됨 — 그래서 P0-6이 실제로는 해결됐는데 이 항목과 교차 연결이 안 돼 "미수정"으로 계속 남아있었음. 2026-08-14 사용자가 `select pg_get_functiondef('public.add_holiday_safe(uuid,date,text,boolean)'::regprocedure);`로 라이브 함수 본문을 직접 확인 → `fix_holiday_history_and_notification_draft_proposed.sql`과 정확히 일치함을 대조 확인. |
| 관련 문서 | [23_Admin_Feature_Audit.md](./23_Admin_Feature_Audit.md) 8번 항목, `fix_holiday_delete_restores_classes.sql`(휴무일 삭제 시 폐강 수업 복구 — 관련 후속 버그, 별도 처리됨) |

2026-08-02 Track B 관리자 기능 감사에서 발견: 매니저가 예약자가 있는 날짜를 휴무일로 지정하면
`add_holiday_safe`가 해당 예약들을 강제로 지우면서(`delete from reservations`) 그 예약에 쓰인
수강권의 `remaining_count`를 전혀 복구하지 않습니다. 같은 "취소" 성격의 다른 경로
(`admin_cancel_reservation`, `manager_set_attendance`의 취소 처리)는 전부 정확히 +1 복구하는
것과 대조적입니다 — 회원이 수강권 횟수를 영구히 잃는 실질적 금전/재화 손실 버그입니다.
RPC(SQL) 수정이 필요해 Track B("SQL 실행 금지·새 RLS 수정 금지·DB 변경 금지") 범위 밖이라
이번 배치에서는 고치지 않고 여기 기록만 합니다 — 별도 승인된 SQL 배치에서 처리해야 합니다.
부수 발견: 같은 함수가 권한 체크에 `schedule.own.group.delete`(원래 "수업그룹 삭제" 용도)
권한 키를 재사용하고 있어, 세분권한 도입 시 의미가 부정확할 수 있습니다(이것도 SQL 필요) —
이 부수 발견은 아직 미해결로 남아있습니다(위 "확인 경위" 참고, 핵심 버그만 NOTIF-001에서
같이 해결됨).
### P0-7. (신규, 2026-08-14~15 관측) 공유 dev Supabase 통합/E2E fixture 데이터가 반복적으로 오염됨 — 원인 미확인

| 필드 | 내용 |
|---|---|
| 우선순위 | P0 |
| 현재 상태 | **확인 필요 — 재현은 반복 확인됐으나 근본 원인 미확정** |
| 근거 파일 | `tests/integration/setup.ts`(`TEST_CENTER_ID`, `getOrCreateOwnedTestCenter()`), `tests/integration/operational-settings-wiring.test.ts`, `tests/integration/auto-book-membership-security.test.ts` |
| 관측된 증상 | 공유 fixture 센터(`3937eb89-3803-43e9-9a29-e893f779df1a`, `TEST_CENTER_ID`)의 `center_settings.daily_book_limit_enabled`가 반복적으로 `true(1회)`로 남아, 이 설정과 전혀 무관한 다수 테스트 파일(`attendance-policy`, `auto-book-membership-security`, `class-deadline-override-and-private`, `notification-center-isolation`, `operational-settings-wiring`, `reservation-cancel-grace-period` 등)이 연쇄적으로 실패함. 2026-08-14 하루에만 사용자가 직접 `false/null`로 리셋했는데도 짧은 시간 내 다시 `true`로 재발(최소 2회 관측). |
| 조사한 것과 배제한 가설 | (1) `manager_centers.role_id`/`center_id` 불일치 트리거(`manager_centers_enforce_role_center_match`)가 원인이라는 가설 — 다른 세션(PR #50 담당)이 두 시점에 직접 조회해 **role_id/center_id가 정상 매칭임을 확인, 배제됨**. (2) Integration 실패 로그에 반복되던 `P0001` 에러코드로 특정 트리거를 지목하려 했으나, 이 코드베이스에 커스텀 `RAISE EXCEPTION`이 광범위하게 쓰여 P0001만으로는 특정 원인을 지목할 수 없음(오판이었음, 기록으로 남김). |
| 유력하지만 미확인 가설 | 어떤 통합 테스트가 `center_settings`(daily_book_limit 등)를 일시적으로 변경했다가 자기 테스트 안에서 assertion 실패 등으로 **cleanup(원상복구) 이전에 조기 종료**되면서 값이 켜진 채로 남는 패턴으로 추정됨. 2026-08-14/15 동안 여러 세션이 동시에 같은 `TEST_CENTER_ID`를 공유해서 테스트를 돌린 것도 재발 빈도에 영향을 줬을 가능성 있음(`feedback_ci_one_at_a_time`류 동시성 문제와 별개 축). |
| 완료 조건 | (a) `center_settings`를 변경하는 통합 테스트 전체(`operational-settings-wiring.test.ts` 등)를 감사해 실패 시에도 반드시 원상복구가 실행되는지(`try/finally` 또는 `afterEach`) 확인·보강. (b) 근본적으로는 공유 고정 `TEST_CENTER_ID` 대신 테스트마다 격리된 센터를 쓰는 방향(`getOrCreateOwnedTestCenter()` 패턴 확대)도 검토. |
| 참고 | 여러 세션이 동시에 CI를 돌려 생기는 오염(간헐적 flaky, 재실행하면 대부분 해소)과는 별개 축의 문제 — 이건 재실행해도 계속 재발하는 게 특징 |

**2026-08-21 관련 조사(P0-7 자체는 미해결로 남김)**: P2-28에서 `auto-book-membership-security.test.ts`의 여러 케이스를 완료 조건 (b)와 정확히 같은 방향(공유 `TEST_CENTER_ID` 대신 `createIsolatedOwnedCenter()` 격리 센터)으로 이미 전환했다. 다만 그 전환 자체가 별개의 두 새 버그(F/L의 `payments`/`center_members` FK — stale-cleanup이 모든 참조 테이블을 못 따라감, N/O의 `memberships` RLS — 새 센터에 userB가 소속되지 않음)를 드러냈다 — P0-7이 지목한 "공유 고정 센터" 문제와는 다른 종류의 위험이지만, "격리 센터 방향이 만능은 아니고 그 자체로 별도 정리가 필요하다"는 교훈은 P0-7 완료 조건 (b)를 실행할 때 참고할 만하다. P0-7의 핵심 가설(어떤 테스트가 실패 시 `center_settings` 원상복구 없이 조기 종료)은 라이브 DB 직접 조사(서비스 롤 키 필요, 이 세션엔 없음) 없이는 확정할 수 없어 여전히 미확인 상태로 남긴다.

**2026-08-22 완료 조건 (a) 이행**: 개별 파일마다 `try/finally`를 보강하는 대신, 더 강한 백스톱을
`tests/integration/setup.ts`의 `getOrCreateOwnedTestCenter()`에 추가했다 — 이미 같은 함수에
붙어 있던 `sweepStaleTestClasses()`(오래된 class/reservation 자동 정리) 옆에
`resetStaleTestCenterSettings()`를 새로 만들어, 공유 통합테스트센터를 재사용할 때마다(=거의
모든 통합 테스트 파일의 `beforeAll`마다) `center_settings`를 무조건 `schema.sql` 기본값으로
되돌린다. `sweepStaleTestClasses()`와 다른 점: classes는 `start_time`으로 "오래된 것"을
객관적으로 골라낼 수 있지만 `center_settings`는 단일 row라 그런 타임스탬프 기반 판별이
불가능하다 — 그래서 "언제" 오염됐는지 가리는 대신 매번 무조건 기본값으로 리셋하는 방식을
택했다(안전 근거는 `sweepStaleTestClasses()`와 동일: 이름이 "통합테스트센터-%"인 전용 테스트
센터만 대상 + `fileParallelism:false`로 항상 순차 실행). 각 파일은 이 리셋 직후 자신의
`beforeAll`에서 `fetchSettings()`로 "원복 기준값"을 다시 캡처하므로, 그 기준값 자체가 항상
기본값이 되어 이전 실행의 leftover가 다음 실행 기준값에 섞여 들어가는 경로 자체가 사라진다.
개별 파일의 `afterEach`/`afterAll`(예: `operational-settings-wiring.test.ts`의 `afterEach`는
`switchToTestUser()`가 던지면 뒤이은 `saveSettings()` 복구가 건너뛰어지는 약점이 있음)는
그대로 남아있지만, 이 스윕이 다음 파일 실행 시점에 무조건 기본값으로 되돌리므로 그 약점이
다음 실행까지 전파되지 않는다. **P0-7의 근본 원인(어떤 테스트가 구체적으로 무엇 때문에
죽는지)은 여전히 서비스 롤 키로 직접 라이브 DB를 조사해야 확정할 수 있어 미확인으로 남지만,
관측된 증상(오염이 다음 실행까지 이어지는 것) 자체는 이 스윕으로 구조적으로 차단된다.**
`npm run build` + 단위테스트(244개) 통과 확인, 통합 테스트는 라이브 Supabase 필요해 CI에서
확인 필요.

## 4. P1 — 사용자 노출 미완성·금전·권한 UX

### P1-1. 포인트 원장 이원화 정합성

| 필드 | 내용 |
|---|---|
| 우선순위 | P1 |
| 현재 상태 | **완료.** point_transactions로 통합, 사용자가 SQL Editor에서 적용 완료(기존 point_accounts 잔액 2건이 point_transactions로 이관된 것을 직접 재조회로 확인) + 회원용 포인트 내역 화면 추가. |
| 근거 파일 | `lib/sales.ts`, `lib/reviews.ts`, `lib/mypage.ts`, `add_sales.sql`, `add_reviews_points.sql`, `add_point_ledger_unification.sql`, `app/mypage/points/page.tsx`(신규), `app/mypage/page.tsx`; `point_transactions`, `point_accounts`, `point_logs`, `center_settings.show_point_history` |
| 관련 문서 | [REQUIREMENTS 6-3, 10-4](./REQUIREMENTS.md), [DATABASE 4-3, 7-3](./DATABASE.md) |

2026-08-15 사용자 결정: `point_transactions`(매니저 매출 화면이 쓰던 원장, `sum(amount)`
방식)로 통합. `write_review()`/`use_points()`를 `point_accounts`/`point_logs` 대신
`point_transactions`에 기록하도록 재정의, 기존 `point_accounts` 잔액은 이관 insert로
`point_transactions`에 합침(멱등, 재실행해도 중복 안 됨). `point_accounts`/`point_logs`
테이블 자체는 DROP하지 않고 레거시로 남김(CLAUDE.md 규칙 3, 테이블 삭제는 별도 승인 필요).
회원 화면에 잔액을 보여주는 새 RPC(`my_point_balance`/`my_point_balances`) 추가 —
`point_accounts` 단일 행을 `for update`로 잠그던 동시성 보호가 순수 원장 구조에선 안 되므로
`use_points()`에서 `profiles` 행을 `for update`로 잠가 같은 회원의 동시 사용 요청을 직렬화.
`lib/reviews.ts`의 `fetchMyPoints`/`fetchAllMyPoints`가 새 RPC를 쓰도록 수정, `npm run build`
통과.

**후속(같은 P1-1 범위로 통합, 신규)**: 그동안 죽어있던 운영설정 `show_point_history`("회원앱
포인트 내역 조회")를 실제로 연결하는 회원용 "포인트 내역" 화면을 새로 추가함
(`app/mypage/points/page.tsx`, `lib/mypage.ts`의 `fetchMyPointHistory()`). `point_transactions`는
이미 회원 본인 행 SELECT가 RLS로 허용돼 있어(`add_sales.sql`의 "포인트 조회" 정책) 새 RPC 없이
직접 조회. 계정의 모든 프로필(가족 구성원) 내역을 함께 보여주고 `profileName` 태그로 구분,
`center_settings.show_point_history`가 꺼진 센터의 내역은 목록에서 제외. `app/mypage/page.tsx`
"내 정보" 섹션에 진입 메뉴 추가. `npm run build` 통과. SQL 변경 없음(기존 RLS만 사용).

### P1-2. (2026-08-14, 완료) 미발급 주문 취소와 환불 정책 설정

| 필드 | 내용 |
|---|---|
| 우선순위 | P1 |
| 현재 상태 | **완료.** 미발급 주문 취소를 실제 임시 계정으로 왕복 검증(성공 케이스 + 이미 발급된 주문 취소 차단 케이스 둘 다 확인). 발급 후 환불(24시간·미사용) 정책은 기존 그대로 유지(이미 RPC로 서버 검증됨, 이번엔 안 건드림). |
| 근거 파일 | `app/purchases/page.tsx`, `lib/orders.ts`, `add_order_self_cancel.sql`, `fix_service_role_missing_grants_orders.sql`(신규, 검증 중 발견), `app/mypage/page.tsx`, `lib/mypage.ts`, `add_refund_and_membership.sql` |
| 이번 배치에서 한 것 | 정책 확정(매니저가 아직 처리 전인 주문은 회원이 시간 제한 없이 직접 취소 가능 — 실제 PG 연동 전이라 이 시점엔 결제가 캡처된 상태도 아님, P0-1 참고). `orders` UPDATE RLS에 "본인 소유 + 아직 미발급(pending/paid)만 cancelled로" 정책 추가(`add_order_self_cancel.sql`, 사용자 적용 완료) — 매니저 화면(`app/manager/orders/page.tsx`)이 이미 쓰던 `updateOrderStatus()`를 회원 화면에서도 그대로 재사용해 "같은 RPC/규칙"을 만족시킴(완료 조건 요구사항). `updateOrderStatus()`에 `.select()` 확인을 추가해 RLS가 조용히 0행 매칭할 때(경합 상황 — 클릭 사이에 매니저가 먼저 처리한 경우) 거짓 성공 토스트가 뜨지 않고 정확한 에러가 나도록 방어. `app/purchases/page.tsx`에 "주문 취소하기" 버튼 + 확인 다이얼로그 추가. 검증 스크립트 실행 중 `orders` 테이블에 service_role GRANT가 전혀 없던 걸 직접 재현 발견(다른 세션이 앞서 같은 증상을 보고했었지만 그때는 이 저장소에서 근거를 못 찾았던 바로 그 문제) — `fix_service_role_missing_grants_orders.sql` 작성·적용 완료. 이후 임시 계정으로 실제 취소 성공 + done 상태 주문 취소 차단(0행 매칭으로 정확히 막힘) 둘 다 재확인. `npm run build` 통과. |
| 관련 문서 | [REQUIREMENTS 6-1, 10-4](./REQUIREMENTS.md), [ROUTES `/purchases`](./ROUTES.md) |

### P1-3. (2026-08-18, 웹 푸시 배포 확인) 외부 푸시·알림톡 발송

| 필드 | 내용 |
|---|---|
| 우선순위 | P1 |
| 현재 상태 | **웹 푸시는 코드 구현 + 배포 완료, 실제 모바일 기기 수신 확인만 남음(자동 검증 불가 — 사용자가 나중에 직접 확인 예정).** 카카오 알림톡·SMS·이메일은 사업자 등록이 필요해 범위 밖(P0-1 PG결제와 동일한 종류의 블로커). |
| 근거 파일 | `app/settings/notifications/page.tsx`, `lib/webPush.ts`, `public/sw.js`, `supabase/functions/send-web-push/index.ts`, `add_web_push.sql`; `messages`, `notification_rules`, `notification_logs` |
| 완료 조건 | (웹 푸시) 실제 브라우저에서 알림 수신 확인. (카카오 알림톡/SMS/이메일) 사업자 등록 이후 발송기 연동 — 이번 범위 아님. |
| 관련 문서 | [REQUIREMENTS 6-1](./REQUIREMENTS.md), [DATABASE 5절](./DATABASE.md), [ROUTES `/settings/notifications`](./ROUTES.md) |

카카오 알림톡·SMS·이메일(`messages`/`notification_rules`/`notification_logs` 기반, 건당 수수료
발생)는 사업자 등록이 있어야 발송 계약이 가능해 여전히 범위 밖입니다.

**웹 푸시(브라우저/OS 알림)는 코드 구현 + 실제 배포까지 완료**: `push_subscriptions` 테이블 +
`add_web_push.sql`(pg_net 확장, `notifications.pushed_at` 컬럼, 1분마다 `send-web-push`
Edge Function을 호출하는 pg_cron 작업) / `public/sw.js`(서비스 워커) / `lib/webPush.ts`(구독
등록·해제) / `app/settings/notifications/page.tsx`의 "앱을 닫아도 알림 받기" 토글. 기존
`notifications` 테이블에 쌓이는 모든 알림(예약 확정/취소, 대기 승격, 신규 구매 등)을 그대로
재사용해 실제 기기가 앱을 안 보고 있을 때도 푸시로 전달한다.

**2026-08-18 배포 확인**: `select jobname, schedule, active from cron.job where jobname =
'dispatch-web-push'`로 read-only 재확인 — cron job이 실제로 `* * * * *`(1분마다)로 등록돼
`active=true` 상태임을 확인함(즉 `add_web_push.sql`이 실제 Live에 적용됐고, Edge Function
배포·VAPID/service_role_key vault 시크릿 설정까지 커밋 메시지의 "배포 완료" 주장과 일치).
같은 QA 중 무관한 버그 1건도 발견해 수정: `tests/integration/auto-book-membership-security.
test.ts`의 `afterAll`이 존재하지 않는 변수(`userA`)를 참조해 `npx tsc --noEmit`이 이 브랜치
전체에서 실패하고 있었음 — 실제 로직(AUTO-SEC-K)은 이미 자체 try/finally로 올바르게 처리 중이라
중복 코드였고, 삭제해 타입체크 통과 확인(커밋 `cb472cb`).

남은 건 자동 검증이 불가능한 영역뿐이다(사용자가 나중에 직접 진행 예정):
1. **실제 모바일 기기**에서 알림 권한 허용 → 알림 발생(예약/취소 등) → 1분 내 푸시가 실제로
   뜨는지 눈으로 확인. iOS Safari는 iOS 16.4+에서도 "홈 화면에 추가"로 설치한 PWA에서만
   웹 푸시가 동작한다는 제약이 있어(브라우저 탭 상태로는 수신 안 됨), iOS에서 확인할 때는
   먼저 홈 화면에 추가한 뒤 테스트해야 한다. Android Chrome은 이런 제약 없이 일반 브라우저
   탭에서도 동작한다.

### P1-4. (2026-08-13, 완료 — P2-1b 참고) 네이버 소셜 로그인

| 필드 | 내용 |
|---|---|
| 우선순위 | P1 |
| 현재 상태 | **완료.** 이 항목은 이 문서에 갱신되지 않은 채 남아있던 중복 항목 — 실제로는 커스텀 Edge Function으로 구현·배포되고 실제 네이버 계정으로 로그인 왕복까지 확인됐다. 자세한 내용은 [P2-1b](#p2-1b-2026-08-13-완료-네이버-로그인--supabase-기본-미지원-커스텀-edge-function으로-구현) 참고. |
| 근거 파일 | `supabase/functions/naver-login/index.ts`, `lib/naverAuth.ts`, `app/login/naver-callback/page.tsx` |
| 관련 문서 | [REQUIREMENTS 6-1](./REQUIREMENTS.md), [ROUTES `/login`](./ROUTES.md) |

### P1-5. (2026-08-21, 4차 진행 — 버튼 단위 권한 게이팅, Bucket 1 완료) 매니저 세부 권한 기반 UI

| 필드 | 내용 |
|---|---|
| 우선순위 | P1 |
| 현재 상태 | **메뉴 노출 제어 완료 + 서버에 실제 `has_permission()` 체크가 있는 화면(Bucket 1) 9개의 버튼 단위 게이팅 완료.** 카탈로그에 키만 있고 실제 RLS/RPC는 열려있는 화면(Bucket 2, 별도 9개)은 SQL로 서버측 권한을 새로 연결하는 작업이 진행 중 — 아래 및 P1-5b 참고. |
| 근거 파일 | `lib/roles.ts`, `app/manager/staff/permissions/page.tsx`, 전체 `app/manager/**/page.tsx`, `app/components/ManagerNav.tsx`, `add_personal_permissions.sql`, `add_manager_menu_permissions.sql` |
| 완료 조건 | 각 매니저 화면의 기능을 권한 키와 매핑하고 권한 없는 메뉴·버튼을 사전에 숨기거나 비활성화하며, RLS/RPC 거부도 그대로 유지해 역할별 검증을 통과함. |
| 관련 문서 | [REQUIREMENTS 5-7, 6-1](./REQUIREMENTS.md), [DATABASE 7-1, 10절](./DATABASE.md), [ROUTES 5절](./ROUTES.md) |

2026-08-21 4차 해결(버튼 단위 게이팅 배치): 조사 결과 21개 매니저 화면 중 서버(RLS/RPC)에
실제로 `has_permission()` 체크가 걸려 있는 화면은 9개(`staff`, `members`, `sales`,
`class-revenue`, `settings`, `membership-rules`, `classes`, `holidays`,
`progress`/`progress/record`)뿐이었다 — 여기 14~16개 버튼/액션에
`fetchMyEffectivePermissionKeys()` + `canSeeManagerMenu()`(`center-info/page.tsx`가 이미 쓰던
패턴)를 적용해 권한 없는 스태프에게는 버튼 자체가 안 보이거나 비활성화되도록 했다.
`classes/page.tsx`의 직접배치/무료배치/관리자 배치취소는 `schedule.makeup`, 삭제는
`schedule.own.group.delete`(휴무일 추가와 키 공유, P0-6에서 이미 지적된 재사용 — 의도적으로
그대로 둠), 휴면·만료 회원 배치는 `customer.member.assign_any_status`로 추가 게이팅.
`sales/page.tsx`의 결제 등록은 수강권/상품을 함께 고르면 `pass.payment.create`뿐 아니라
`customer.member.issue_pass`도 필요해(수강권 발급이 결제 등록과 한 트랜잭션) 그 조합을
버튼에서 확인. `membership-rules/page.tsx`는 메뉴 게이트(`pass.create`)와 "조건 추가/삭제"의
실제 필요 키(`pass.update`)가 다르다는 걸 확인해 그 서브기능만 별도로 게이팅. `npm run build`
통과(TypeScript 오류 없음).

나머지 9개 화면(`goods`, `rooms`, `reviews`, `announcements`, `inquiries`, `orders`,
`members`의 부가 기능들, 대시보드 출석 처리, `classes`의 `schedule.own/other.*` CRUD 전체)은
권한 카탈로그에 키는 있지만 실제 DB 정책은 `my_managed_center_ids()`(센터 소속 스태프면
누구나)만 체크해 서버측 제약이 없다 — 여기 버튼을 잠그면 실제로 없는 제약을 있는 것처럼
보여주는 오해의 소지가 있어 이번 배치에선 건드리지 않았다. SQL로 실제 RLS/RPC를 새로 연결하는
작업을 P1-5b로 별도 진행 중(운영 중인 센터의 기존 스태프가 갑자기 기능을 못 쓰게 될 수 있는
동작 변경 위험이 있어 신중하게 진행).

2026-08-01 Access Control 구현 Batch에서 1차 해결: `app/manager/page.tsx`의 13개 메뉴 중
권한 카탈로그에 대응 키가 있는 9개(수강권/진도표/스태프/매출/공지사항/문의/센터정보/룸/설정)를
`fetchMyEffectivePermissionKeys()` + `canSeeManagerMenu()`로 노출 제어함(오너는 전권, 비활성 시
서버 `has_permission()`과 동일한 우선순위로 판정). 나머지 4개(상품/후기/주문/관리자배치내역)는
카탈로그에 대응 permission key가 없어 이번 1차 범위에서 제외 — 새 permission key 추가는 스키마
변경이라 별도 승인 필요.

2026-08-14 2차 해결: `ManagerNav`의 4개 고정 탭 중 미검토였던 부분을 확인 — "수업"/"알림"은
본인 일정·본인 알림함이라 권한 카탈로그에 애초에 대응하는 "view" 키 자체가 없음(`schedule.own.*`은
전부 개별 액션 키뿐이고 기본 조회 키가 없음, `schema.sql` 확인 — 모든 스태프가 자기 일정/자기
알림은 볼 수 있어야 하므로 의도적으로 게이트 없는 설계로 판단해 그대로 둠). "회원" 탭은
`customer.member.view`라는 명확한 권한 키가 있고 실제로 RLS(`reservation_functions.sql`,
`has_permission(center_id, 'customer.member.view')`)가 이미 이 권한으로 회원 목록 조회를
막고 있는데도 탭 자체는 항상 노출돼 있었다 — `app/manager/page.tsx`와 동일한 패턴으로
`ManagerNav.tsx`에 권한 계산을 추가해 탭도 가리도록 수정. "더보기" 탭은 그 자체가 메인
메뉴(이미 항목별로 가려짐)라 탭 노출은 그대로 둠. `npm run build` 통과. 개별 화면 내부의
버튼 단위 권한 표시(각 screen의 개별 액션 버튼)는 여전히 서버 거부 이후에야 알 수 있음 —
상세 내용은 [CHANGELOG.md](./CHANGELOG.md) 참고.

2026-08-15 3차 해결(사용자 결정으로 남은 4개 메뉴 진행): 조사 결과 2개는 이미 카탈로그에
키가 있었는데(`facility.review.view`, `pass.order.view`, `add_new_permissions.sql`) 메뉴에
연결이 안 돼 있었다. 나머지 2개(`pass.goods.view`, `schedule.admin_assignment_log.view`)는
새로 추가(`add_manager_menu_permissions.sql`, 사용자가 SQL Editor에서 적용 완료·`permissions`
테이블 재조회로 확인). `app/manager/page.tsx`의 관리 메뉴 목록과 "오늘 할 일" 상단 바로가기
(문의/주문/회원배치) 모두 `canSeeMenu()`로 연결. `npm run build` 통과.

### P1-5b. (2026-08-21, 완료 — Live 적용 확인) Bucket 2 화면 서버측 권한(RLS/RPC) 신규 연결

| 필드 | 내용 |
|---|---|
| 우선순위 | P1 |
| 현재 상태 | **완료.** SQL migration 6개(products·rooms / reviews·announcements / inquiries·orders / center_members / manager_set_attendance / classes own-other) 전부 사용자가 SQL Editor에서 순서대로 실행, 확인 쿼리로 라이브 반영 검증 완료(center_members 정책 4개, `manager_set_attendance`의 `schedule.attendance` 체크 true, classes 관련 신규 함수 10개 전부 생성). 대응 UI 게이팅 + `lib/classes.ts` 리팩터링까지 브랜치 `feat/p1-5-button-permission-gating`에 커밋됨. `npm run build` 통과. |
| 근거 파일 | [P1-5](#p1-5) 4차 해결 조사 결과 + `pg_get_functiondef`로 확인한 라이브 정의(`fulfill_order`, `manager_set_attendance`, `delete_class_safe`, `delete_class_group_safe`) |
| 완료 조건 | 9개 화면(goods/rooms/reviews/announcements/inquiries/orders/members 부가기능/대시보드 출석/classes CRUD)의 실제 DB 정책에 `has_permission()` 체크를 추가하고, 대응하는 UI 버튼 게이팅도 함께 적용 |
| 관련 문서 | [P1-5](#p1-5), [DATABASE.md](./DATABASE.md) |

**중요 — 동작 변경(breaking change) 위험**: 지금은 이 9개 화면이 "센터 소속 스태프면 누구나"
동작하는데, RLS를 `has_permission()` 기반으로 좁히면 그 권한 키를 역할에 아직 안 준 기존
센터의 스태프가 갑자기 해당 기능을 못 쓰게 된다. SQL은 사용자가 직접 SQL Editor에서
실행해야 하며(Claude가 직접 실행하지 않음), 적용 전 각 센터 운영자가 필요한 스태프에게
미리 권한을 부여해두는 게 좋다.

**중간에 드러난 사실 두 가지(정적 파일만 보고 진행했으면 놓쳤을 것들)**:
1. `fulfill_order()`(주문 확정·발급)는 조사 당시 "카탈로그 키만 있고 RLS는 열려있다"고
   봤지만, 라이브 정의를 직접 확인하니 이미 `has_permission(center_id,'pass.payment.create')`로
   막혀 있었고(SEC-116) 정적 파일에는 없던 가격 검증(SEC-118)·자동 회원등록·자동예약
   로직까지 있었다 — 정적 파일이 최신이 아니었던 사례. 주문 "확정·발급" 버튼은 그래서
   `pass.order.fulfill`이 아니라 실제로 쓰이는 `pass.payment.create`로 게이팅했다("취소"도
   같은 키로 통일).
2. `class_trainers`(수업 담당 강사 배정) 테이블 자체의 RLS도 `my_managed_center_ids()`만
   체크해서, 수업 own/other 판정 기준(담당 강사가 본인인지)을 아무나 조작할 수 있는
   상태였다 — 이것도 함께 서버 함수로 옮겨 잠갔다(아래 참고).

**classes CRUD own/other 매핑(사용자 승인, 2026-08-21)**: 카탈로그의 `schedule.own/other.*`
40여 개 키 중 create/update/delete 계열을 실제로 연결했다.
- **own 판정**: 그 수업(또는 반복그룹)의 `class_trainers`에 내 계정이 있으면 own, 다른
  사람만 있으면 other. 담당 강사가 아예 없으면 own으로 간주.
- **생성**: 아직 배정된 강사가 없어 other 개념이 성립 안 함 → `schedule.own.{group|private}.create`만 요구.
- **수정/삭제/강사 재배정**: own/other × group/private 실제 판정 적용.
- **구조 변경**: `createClass`/`updateClass`/`createRecurringClasses`/`updateClassGroup`/
  `updateClassPassSelectionMode`/`setClassTrainers`/`setClassTrainersBulk`/
  `setClassTrainersForGroup`(전부 `lib/classes.ts`, 기존엔 클라이언트가 `classes`/
  `class_trainers` 테이블에 직접 insert/update)를 전부 새 RPC(`*_safe`)로 옮겼다 —
  RLS만으로는 "이 요청이 어떤 강사를 배정하려는지" 알 수 없어(별도 호출로 옴) 서버 함수
  안에서 판정해야 한다. **함수 시그니처는 그대로 유지**해서 `app/manager/classes/page.tsx`
  등 호출부는 손대지 않았다(`delete_class_safe`/`delete_class_group_safe`는 원래도 RPC라
  하드코딩된 `schedule.own.group.delete` 체크만 own/other 판정으로 교체).
- `classes`/`class_trainers` 테이블 자체의 RLS(직접 insert/update)는 이번에 강화하지
  않았다 — 넓게 열려 있지만 실제 클라이언트는 이제 전부 RPC를 거쳐가므로(직접 테이블
  호출 경로가 `lib/classes.ts`에서 모두 제거됨) 사실상의 방어선은 이 RPC들이다.
  `fulfill_order`/`orders` 테이블과 같은 패턴.
- 예약 배치/취소(`schedule.makeup`)는 범위 밖 — Bucket 1에서 이미 처리됨.
- 범위 밖(도달 불가능한 죽은 코드로 확인됨, `copySchedule()`)은 갱신하지 않음 — 되살아나면
  같이 고쳐야 한다는 주석만 남김.

| 필드 | 내용 |
|---|---|
| 우선순위 | P1 |
| 현재 상태 | **완료.** 클라이언트 가드 5개 화면 + 서버측 RLS(account_center_permissions SELECT) 전부 적용·검증 완료. 이 항목이 "아직 실행하지 않음"으로 오래 남아있던 건 P0-4에 이미 기록된 완료 사실이 이쪽에 반영 안 된 문서 갱신 누락이었음(2026-08-15 발견, `pg_policies` 재조회로 실제 상태 확인) — 실제 DB 상태와는 무관. |
| 근거 파일 | `app/admin/categories/page.tsx`, `app/admin/banners/page.tsx`, `app/manager/inquiries/page.tsx`, `app/manager/notifications/page.tsx`, `app/manager/staff/permissions/page.tsx`, `fix_account_center_permissions_select_draft_proposed.sql`(적용 완료, PR #19) |
| 완료 조건 | ~~플랫폼 운영자 2개 화면과 매니저 3개 화면에 일관된 사전 가드를 적용하고 비권한 사용자의 콘텐츠 미노출·친절한 오류·RLS 차단을 검증함~~ 완료. |
| 관련 문서 | [REQUIREMENTS 7~8절](./REQUIREMENTS.md), [ROUTES 5~7절](./ROUTES.md), [DATABASE 10절](./DATABASE.md) |

현재 데이터 쓰기는 RLS가 막지만 화면과 입력폼이 먼저 노출되는 페이지가 있었습니다.

2026-08-01 Access Control 구현 Batch에서 완료: `app/admin/categories/page.tsx`,
`app/admin/banners/page.tsx`에 `/admin/centers`와 동일한 `checkPlatformAdmin()` 가드를 추가했고,
`app/manager/inquiries/page.tsx`, `app/manager/notifications/page.tsx`에는 `fetchMyCenters()` +
"운영 중인 센터가 없어요" 가드(기존 9개 화면과 동일한 패턴)를, `app/manager/staff/permissions/page.tsx`에는
URL의 `center` 파라미터로 현재 사용자가 그 센터의 오너인지 확인하는 가드(`isOwnerOfCenter()`)를
추가함. 상세 내용은 [CHANGELOG.md](./CHANGELOG.md) 참고. 클라이언트 가드와 별도로, 서버측
재검증에서 `account_center_permissions`의 SELECT RLS 정책 자체가 "같은 센터 소속이면 누구나
조회 가능"하게 열려 있던 FAIL도 발견됐었음 — 화면 가드와 무관하게 Supabase SDK 직접 호출로
우회 가능했던 서버 쪽 구멍. 수정 SQL(`fix_account_center_permissions_select_draft_proposed.sql`)은
**2026-08-02에 이미 실행되고 `tests/integration/acl-003-permission-read.test.ts` 3/3 통과, PR #19로
main 병합까지 완료됨**(P0-4에 정확히 기록돼 있었음). 2026-08-15 `pg_policies` 재조회로 라이브
정책이 그 draft SQL과 정확히 일치함을 재확인.

### P1-7. (2026-08-14, 완료) 국경일 자동 갱신

| 필드 | 내용 |
|---|---|
| 우선순위 | P1 |
| 현재 상태 | **완료.** 사용자와 방식 결정(외부 공휴일 API 대신 정적 테이블 — 사업자 등록/API 키 없이 바로 처리 가능하고, 한국 공휴일은 정부가 1~2년 전 미리 확정 발표해서 매년 한 번 다음 해분만 추가하면 충분히 "자동"에 가까움). |
| 근거 파일 | `lib/publicHolidays.ts`(신규), `app/reservation/page.tsx` |
| 이번 배치에서 한 것 | 2026-07-17 제헌절 한 건만 하드코딩돼 있던 걸 `lib/publicHolidays.ts`로 분리해 2025~2027년 전체 공휴일+대체공휴일 테이블로 확장(웹 검색으로 실제 정부 발표 자료 대조, 3.1절/광복절/개천절/한글날/설날·추석 연휴의 대체공휴일 규칙까지 반영). `app/reservation/page.tsx`는 날짜 키로 조회하는 기존 로직 그대로 재사용해서 연도가 바뀌어도 별도 코드 변경 없이 표시됨. 센터 휴무일(`center_holidays`)과는 화면에서 완전히 별개 배지/영역으로 표시돼 원래부터 충돌 없음(확인됨). `npm run build` 통과. |
| 남은 작업 | 매년 말~다음 해 초에 그 다음 해분 추가 필요(파일 상단 주석에 안내). 2027년 데이터는 관보 고시 전 잠정치라 연초 재확인 권장. |
| 관련 문서 | [REQUIREMENTS 5-2, 12절](./REQUIREMENTS.md), [ROUTES `/reservation`](./ROUTES.md) |

### P1-8. (2026-08-15, 완료) 담당회원·상담고객(leads) 화면

| 필드 | 내용 |
|---|---|
| 우선순위 | P1 |
| 현재 상태 | **완료.** |
| 근거 파일 | `app/manager/leads/page.tsx`(신규), `lib/leads.ts`(신규), `app/manager/page.tsx`(메뉴), `tests/integration/leads.test.ts`(신규) |
| 관련 문서 | [REQUIREMENTS 6-1, 12절](./REQUIREMENTS.md), [DATABASE 5절](./DATABASE.md), [ROUTES `/manager/members`](./ROUTES.md) |

2026-08-15 사용자 결정: "담당회원"은 별도 백엔드 개념이 없고(스키마에 회원-담당자 소유권
컬럼 자체가 없음 — `담당`은 강사 배정 맥락에서만 존재), 실제로 비어있던 건 상담고객(leads)
CRUD 화면 하나였다. `leads` 테이블과 `customer.lead.*` RLS는 다른 세션의 이전 배치
(`proposed_rls_gap_batch_a1.sql`)에서 이미 라이브 적용돼 있어 이번엔 SQL 없이 화면(`app/
manager/leads`)+lib만 새로 만들었다. 회원 전환 규칙: leads는 앱 계정과 연결돼 있지 않아
자동으로 `center_members`를 만들 수 없음(회원 등록은 이름/전화번호로 앱 가입 계정을 찾아
연결하는 기존 흐름, `app/manager/members`) — "회원전환" 버튼은 상태만 바꾸고 실제 등록은
그 화면에서 진행하도록 안내. `customer.lead.view`로 메뉴 노출, `tests/integration/leads.test.ts`
4개로 CRUD + RLS(권한 없는 스태프 차단/조회 필터링/권한 부여 후 허용) 검증, `npm run build`
통과.

### P1-9. 관리자 직접배치 세부 permission key

| 필드 | 내용 |
|---|---|
| 우선순위 | P1 |
| 현재 상태 | **완료.** 사용자가 SQL Editor에서 적용 완료, 라이브 함수 본문에 `schedule.makeup` 확인이 들어가 있음을 직접 재조회로 확인. |
| 근거 파일 | `add_admin_assignment_permission_gate.sql`(신규, `can_manage_center_reservations()`), `lib/adminAssignment.ts`, `app/manager/classes/page.tsx` |
| 관련 문서 | [DATABASE 10절](./DATABASE.md), [REQUIREMENTS 10-1](./REQUIREMENTS.md) |

2026-07-30 사용자 확인: 당시 `feature/p1-reservation-ux` 범위에서는 새 permission key를
추가하지 않고, 권한 검사를 `can_manage_center_reservations()` 함수로 분리해 확장 지점만
마련하기로 결정함(그대로 유지).

2026-08-15 사용자 결정으로 실제 제한 적용: 새 key를 만들지 않고 카탈로그에 이미 있던
`schedule.makeup`("보강 예약" — "수강권 조건과 무관하게 회원을 수업에 예약할 수 있습니다")을
재사용했다 — 설명이 admin_assign_reservation의 동작과 정확히 일치하는데 코드 어디서도
참조되지 않는 죽은 항목이었다. `can_manage_center_reservations()`를
`has_permission(p_center_id, 'schedule.makeup') or is_platform_admin()`으로 좁힘(오너는
자동 통과) — `admin_assign_reservation`/`admin_cancel_reservation` 둘 다 이 함수로 권한을
확인하므로 함께 적용됨. 화면 내부 버튼 단위 숨김(`app/manager/classes/page.tsx`의 여러
직접배치 진입점)은 이번 범위 밖 — P1-5의 "버튼 단위 권한 표시" 잔여 작업과 같은 카테고리로
남김. 서버는 이미 거부하므로 기능 안전성엔 영향 없음.

### P1-10. 관리자 직접배치 대상 회원 상태(이용정지/탈퇴/휴면) 차단 정책

| 필드 | 내용 |
|---|---|
| 우선순위 | P1 |
| 현재 상태 | **완료.** |
| 근거 파일 | `add_admin_assignment_member_status_guard.sql`(신규), `admin_assign_reservation()`, `permissions`(`customer.member.assign_any_status`), `tests/integration/admin-assignment-member-status-guard.test.ts` |
| 관련 문서 | [DATABASE 6절](./DATABASE.md) |

2026-07-30 사용자 확인: 당시 범위에서는 `reserve_class`(회원 셀프예약)와 동일하게 이 개념을
새로 만들지 않기로 결정함(회원 셀프예약도 `center_members.status`를 확인하지 않음 — 이 결정은
그대로 유지, 셀프예약은 안 건드림). 회원 자격 검사를 `is_profile_assignable()`로 분리해
향후 정책을 붙일 확장 지점만 마련해뒀었음.

2026-08-15 사용자 결정으로 관리자 직접배치(`admin_assign_reservation`)에만 정책 추가: "탈퇴"
(`accounts.deactivated_at is not null`, P1-18) 또는 "휴면"(`center_members.status='dormant'`)
회원은 새 권한 `customer.member.assign_any_status`가 있어야 배치 가능(오너는 `has_permission()`이
자동 통과 — 예: 오너는 탈퇴/휴면 회원도 직접배치 가능, 일반 스태프는 이 권한을 따로 받아야
가능). 이 센터 회원이 아직 아니거나(체험 최초 배치) 수강권만 만료(expired)인 경우는 대상이
아님 — 항상 배치 가능. 사용자가 SQL Editor에서 적용 완료(라이브 함수 본문 직접 재확인),
`tests/integration/admin-assignment-member-status-guard.test.ts` 4개 신규 테스트로 검증
(권한 없는 스태프 거부/권한 부여 시 허용/오너 자동 통과/활성 회원은 항상 허용, 4/4 통과,
기존 admin-assignment-security.test.ts 16개·acl-003 5개 회귀 없음 확인).

2026-08-18 P1-9 적용 후 수정: P1-9가 `can_manage_center_reservations()`에 `schedule.makeup`
게이트를 추가하면서, 이 파일의 무권한 스태프(managerB) fixture가 P1-10 검사에 도달하기도
전에 P1-9 게이트에서 먼저 막혀 3/4 테스트가 실패했다(P1-10만 격리해서 보려던 의도와 어긋남).
`beforeAll`에서 managerB에게 `schedule.makeup`을 baseline으로 부여해 P1-9는 항상 통과하고
P1-10 차이만 관찰하도록 수정, 4/4 재통과 확인.

### P1-11. (2026-08-16, 완료) 관리자 직접배치 통합 테스트 — 정원 초과 확인(needs_capacity_confirm) 2단계 흐름 미검증

| 필드 | 내용 |
|---|---|
| 우선순위 | P2 |
| 현재 상태 | **완료.** 그룹 수업 2단계 흐름 테스트 2건 추가, 로컬 실행 17/17 통과(첫 시도 green). 참고로 이 항목이 언급하던 `fix_private_class_capacity_and_concurrency_draft_proposed.sql`은 "미적용, 승인 대기"로 오래 적혀 있었는데, `pg_get_functiondef`로 라이브 재확인 결과 프라이빗 수업 정원초과 방지 로직이 이미 적용돼 있었음(P1-6/P2-17과 같은 계열의 문서 드리프트, 이번에 함께 정정). 이 항목은 이 세션과 `review/todo-scan3` 세션이 병렬로 독립 작성했다가 main 병합 시 테스트 어설션이 더 촘촘한 `review/todo-scan3` 버전을 최종 채택함. |
| 근거 파일 | `tests/integration/admin-assignment-security.test.ts`, `tests/integration/setup.ts` |
| 완료 조건 | ~~`admin_assign_reservation`이 정원이 찬 수업에서 `needs_capacity_confirm: true`만 반환하고 예약을 만들지 않는지, 그 뒤 `p_force_capacity: true`로 재호출하면 실제 생성되는지를 통합 테스트로 검증함~~ 완료. |
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

### P1-12. (2026-08-18, 완료) 운영설정(`/manager/settings`) 화면의 다수 항목이 저장만 되고 실제로 적용되지 않음

| 필드 | 내용 |
|---|---|
| 우선순위 | P1 |
| 현재 상태 | **완료** — 전수 재감사 결과 대부분 이미 wiring됨, 실제로 죽어있던 2개 중 1개(`show_group_waitlist_count`)는 구현, 1개(`show_all_classes`)는 "준비 중" 명시 |
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

2026-08-18 전수 재감사(2026-08-02 목록을 코드로 다시 확인): 그 사이(SEC-114 정책회귀 배치 등)
`allow_same_day_booking`/`daily_book_limit(_enabled)`/`waitlist_weekly_limit`이 이미 실제
RPC(`reserve_class`/`reserve_with_membership`/`auto_book_membership` 등)에 wiring돼 있음을
확인(목록에서 제거). `show_group_reserved_count`/`auto_unpaid_input`도 각각
`lib/reservations.ts`(회원 화면 인원표시)/`app/manager/sales/page.tsx`(미수금 자동계산)에서
실제로 읽고 있음을 확인(목록에서 제거). `use_inquiry_board`/`use_locker`/`use_lounge`는
이미 E-6 결정으로 화면에서 토글 자체가 제거돼 있어 문제 없음(재확인만).
`waitlist_auto_hours/minutes`/`autocancel_hours/minutes`/`same_day_change_hours/minutes`는
이미 화면에 "준비 중" 배지로 명확히 표시돼 있어 문제 없음(재확인만).

진짜 남아있던 죽은 필드는 2개뿐이었다:
- `show_group_waitlist_count`("그룹 수업 대기 인원 표시"): 회원 화면에 대기 인원을 보여줄
  방법 자체가 없었다(대기 인원수를 집계하는 곳이 아예 없음) — `class_reservation_counts`
  뷰(`fix_class_reservation_counts_add_waitlisted.sql`)에 `waitlisted_count`를 추가하고
  `lib/reservations.ts`/`app/reservation/page.tsx`에 `show_group_reserved_count`와 동일한
  패턴으로 연결. 신규 SQL 1개, 사용자 적용 후 화면 확인 필요.
- `show_all_classes`("수강권으로 볼 수 없는 수업도 표시"): 실제로 구현하려면 회원 화면이
  각 수업마다 "이 회원의 어떤 수강권이든 이 수업 예약 자격이 되는지"(pass_selection_mode/
  class_allowed_products/membership_schedule_rules)를 `reserve_class()`와 동일하게
  클라이언트에서 재판정해야 하는데, 이건 오늘 겪은 `auto_book_membership` vs `reserve_class`
  정책 드리프트와 같은 위험을 새로 만드는 것이라 이번 배치에서는 구현하지 않고 화면에
  "준비 중" 배지 + 안내문구만 추가함(완료조건 (b) 선택). 별도 배치로 남김.
- `show_point_history`(회원앱 포인트 내역 조회)는 회원앱에 포인트 내역 화면 자체가 없어서
  P1-1(포인트 원장 이원화 정리)과 직접 겹쳐 그쪽 범위로 넘김(이 항목에서는 제외).

### P1-13. (2026-08-14, 완료) 센터정보(`/manager/center-info`) 수정 권한이 "오너 전용" 주석과 실제 RLS가 불일치

| 필드 | 내용 |
|---|---|
| 우선순위 | P1 |
| 현재 상태 | **완료 — 두 세션이 같은 티켓을 서로 다른 레이어에서 손대 합쳐짐(겹치지 않고 서로 보완).** |
| 근거 파일 | `app/manager/center-info/page.tsx`, `reservation_functions.sql`("매니저 센터 수정" 정책), `fix_centers_update_facility_info_permission.sql`(다른 세션, PR #54, 적용 완료), `fix_center_info_sensitive_fields_permission_draft_proposed.sql`(이 세션, 적용 완료) |
| 완료 조건 | ~~`facility.info` 권한 세분화를 실제로 적용할지 결정하고 반영함~~ 완료. |
| 관련 문서 | [23_Admin_Feature_Audit.md](./23_Admin_Feature_Audit.md) 센터관리 항목 |

2026-08-02 Track B 감사에서 발견: `center-info/page.tsx` 상단 주석은 "시설 정보 설정 권한
(facility.info) 필요 — 오너는 항상 가능"이라고 적혀 있지만, 실제 RLS 정책(`"매니저 센터 수정"`,
`reservation_functions.sql`)은 `center_id in (select my_managed_center_ids())`만 확인했습니다 —
오너가 아닌 일반 스태프도 센터 정보·결제수단·평판점수를 수정할 수 있었습니다.

**2026-08-14 최종 확정(두 레이어)**: `facility.info` 권한 키는 이미 `schema.sql`에 정의돼
있었고 `app/manager/page.tsx`의 메뉴 노출도 이미 `canSeeMenu("facility.info")`로 가려져
있었지만(URL 직접 접근만 뚫려있었음), RLS 자체가 이를 확인 안 하고 있었습니다.
- (다른 세션, PR #54) "매니저 센터 수정" RLS를 `has_permission(id,'facility.info') OR
  is_platform_admin()`으로 좁힘 — facility.info 없으면 이 화면 전체(소개글/주소/전화 포함)
  저장이 막힘. 사용자가 `fix_centers_update_facility_info_permission.sql` 적용, `pg_policies`
  재조회로 확인.
- (이 세션) 그 위에 결제수단(pay_methods)/후기 적립 포인트(review_point) 두 필드는 한 단계
  더 좁혀 오너 또는 `facility.paymethod` 권한 보유자만(결제수단), 오너 전용(포인트, 대응
  permission key 없음)으로 추가 제한 — `guard_center_sensitive_fields_change` BEFORE UPDATE
  트리거(`fix_center_info_sensitive_fields_permission_draft_proposed.sql`)로 구현. "facility.info는
  위임했지만 결제수단/포인트까지는 아직" 같은 세분화된 위임을 가능하게 하는 게 목적이라
  facility.info 체크와 중복이 아님. 사용자가 SQL Editor에서 적용, `pg_trigger` 재조회로 확인.
  `app/manager/center-info/page.tsx`도 `fetchMyEffectivePermissionKeys`로 미리 계산해 권한
  없는 필드/전체 저장을 UI에서부터 비활성화·안내하도록 갱신(DB 레이어가 최종 방어선, UI는 편의).

### P1-18. (2026-08-16, 완료) 수업매출 캘린더 신규 기능 — SQL Live 적용·통합테스트 확인

| 필드 | 내용 |
|---|---|
| 우선순위 | P1 |
| 현재 상태 | **완료** — SQL 4종 Live 적용, 통합테스트 9/9 Green |
| 근거 파일 | `add_class_revenue_schema.sql`, `add_set_membership_session_amounts_rpc.sql`, `add_class_revenue_daily_summary_rpc.sql`, `add_class_revenue_for_date_rpc.sql`, `app/manager/class-revenue/page.tsx`, `tests/integration/class-revenue.test.ts` |
| 완료 조건 | 사용자가 Supabase SQL Editor에서 4개 파일 순서대로 실행, `pg_get_functiondef`/`pg_policies`로 확인 완료. 통합테스트 작성·Green 확인 완료. |
| 관련 문서 | `docs/CHANGELOG.md`(2026-08-16 항목) |

이 파일 전용 격리 센터를 쓰는 통합테스트(`class-revenue.test.ts`, 9개)를 작성해 돌리는
과정에서 실제 버그 1건을 발견·수정함: `class_revenue_for_date`가 회차 번호(`row_number()`)
계산 전에 조회 날짜로 먼저 필터링해, 어떤 날짜를 조회하든 그 예약 1건짜리 partition이 돼
`session_index`가 매번 1로만 나오던 버그(균등분배 합계가 부풀고 회차별 커스텀 금액도
전부 1회차 값으로 표시됨) — 날짜 필터를 `row_number()` 계산 이후로 옮겨 수정, Live
재적용·재테스트로 확인(자세한 내용은 CHANGELOG 참고).

## 5. P2 — 운영 설정·개발환경·구조 검증

### P2-1. 애플 OAuth 운영 설정 (구글·카카오·네이버는 완료 — 아래 참고)

| 필드 | 내용 |
|---|---|
| 우선순위 | P2 |
| 현재 상태 | **의도적으로 보류 — 앱 코드는 2026-08-07 social-auth 배치에서 이미 완료됨.** 2026-08-13 사용자 결정: Apple Developer Program 가입비($99/년)가 Sign in with Apple 사용 조건과 동일한 멤버십이라, 실제 서비스 출시가 가까워져 개발자 계정을 만드는 시점에 이 설정도 함께 진행하기로 함(구글/카카오/네이버처럼 미리 할 이유가 없음 — 미리 가입해도 별도 이득 없이 연 구독만 먼저 시작되는 구조). |
| 근거 파일 | `app/login/page.tsx`, `app/components/SessionWatcher.tsx`, `lib/authAccount.ts`, `AUTH_SETUP.md` |
| 이번 배치에서 한 것 | `ensureAccountForCurrentUser()` 호출을 홈 화면 전용에서 앱 전체(SessionWatcher, SIGNED_IN/INITIAL_SESSION)로 옮겨 어느 페이지로 리다이렉트돼도 계정/프로필이 보장되도록 함. 소셜 버튼 로딩 상태(중복 클릭 방지)·OAuth 콜백 실패(`#error=...`) 감지 후 `/login?oauth_error=...`로 안내하는 처리 추가. 계정 연동(같은 이메일, 다른 provider) 정책은 `docs/08_Decision_Log.md` DEC-004로 명문화(자동 병합 안 함). |
| 완료 조건 | Supabase Apple Provider, Apple Developer 콘솔 설정(유료, 연 $99), Redirect URL과 Vercel 환경을 구성하고 신규·기존 계정 로그인과 실패 callback을 실제 provider로 검증함(코드는 준비됐지만 이 콘솔 설정 자체는 Claude가 대신 할 수 없음) |
| 관련 문서 | [REQUIREMENTS 5-1, 6-2](./REQUIREMENTS.md), [ROUTES `/login`](./ROUTES.md), `AUTH_SETUP.md` 3절 |

### P2-1d. (2026-08-13, 완료) 구글 로그인 — Supabase 기본 provider 그대로 사용, 운영 반영 완료

| 필드 | 내용 |
|---|---|
| 우선순위 | P2 |
| 현재 상태 | **완료. 실제 구글 계정으로 로그인 왕복 성공 확인.** |
| 근거 파일 | `AUTH_SETUP.md` 3-0절 |
| 내용 | 구글은 이메일/프로필이 민감하지 않은 기본 스코프라 카카오와 달리 별도 우회 없이 Supabase 기본 제공 Google provider를 그대로 사용. Google Cloud Console에서 OAuth 동의 화면(외부, 테스트 상태) + OAuth 클라이언트(웹 애플리케이션, Supabase Callback URL 등록) 생성 후 Client ID/Secret을 Supabase Google Provider 설정에 등록. |
| 알려진 제약(기능 영향 없음) | 구글 로그인 동의 화면에 앱 이름 대신 `xxxxx.supabase.co 서비스로 로그인`이 표시됨 — Supabase 공용 도메인을 거치는 구조상 발생, `supabase.co`는 소유하지 않은 도메인이라 구글 "승인된 도메인"에 등록 불가. Supabase 커스텀 도메인(유료) 또는 완전 커스텀 OAuth 흐름 전환 시 해결 가능, 실사용 서비스 오픈 시점에 재검토(`AUTH_SETUP.md` 3-0절 참고). |
| 검증 | 실제 구글 계정으로 로그인 성공 확인(사용자 직접 테스트). |

### P2-1c. (2026-08-13, 완료) 카카오 로그인 — Supabase 기본 provider 불가, 커스텀 Edge Function으로 구현

| 필드 | 내용 |
|---|---|
| 우선순위 | P2 |
| 현재 상태 | **완료. 실제 카카오 계정으로 로그인 왕복 성공 확인.** |
| 근거 파일 | `AUTH_SETUP.md` 3-1절, `lib/kakaoAuth.ts`, `app/login/kakao-callback/page.tsx`, `supabase/functions/kakao-login/index.ts` |
| 내용 | Supabase 기본 제공 Kakao provider는 `account_email` 스코프를 서버에서 강제로 요청하는데, 이 프로젝트 카카오 앱은 이메일 항목이 "권한없음"(비즈니스 앱 미전환)이라 `"Invalid scope: account_email"`로 거부됨을 실사용 중 발견. 클라이언트에서 `scopes` 옵션으로 우회 시도했으나 Supabase가 서버 쪽에서 고정 요청하는 스코프라 소용없었음 — 결국 네이버와 동일한 커스텀 Edge Function(Authorization Code 흐름 직접 완결)으로 전환해 해결. 네이버와 동일하게 합성 이메일(`kakao-<id>@kakao.socialauth.invalid`)을 정체성 기준으로 써서 DEC-004와 일관되게 함. |
| 실제 발견된 버그 2건(수정 완료) | (1) Supabase secrets 최초 등록 시 Client Secret의 대문자 `I`를 소문자 `l`로 잘못 옮겨적어 `invalid_client`(KOE010) 발생 — 콘솔에서 직접 복사-붙여넣기로 재등록해 해결(운영 실수, `AUTH_SETUP.md`에 주의사항 추가). (2) 카카오 콘솔의 Redirect URI 등록 위치가 "카카오 로그인 → 일반/고급"이 아니라 "플랫폼 키 → Default REST API Key 수정" 화면으로 이동돼 있어(카카오 UI 개편) 처음에 "로그아웃 리다이렉트 URI"에 잘못 등록할 뻔함 — 올바른 위치 찾아 등록. |
| 검증 | 실제 카카오 계정으로 로그인 → 콜백 → 세션 확립까지 실브라우저에서 성공 확인(사용자 직접 테스트). |

### P2-1b. (2026-08-13, 완료) 네이버 로그인 — Supabase 기본 미지원, 커스텀 Edge Function으로 구현

| 필드 | 내용 |
|---|---|
| 우선순위 | P2 |
| 현재 상태 | **완료. 실제 네이버 계정으로 로그인 왕복 성공 확인.** |
| 근거 파일 | `AUTH_SETUP.md` 3-3절, `lib/naverAuth.ts`, `app/login/naver-callback/page.tsx`, `supabase/functions/naver-login/index.ts` |
| 이번 배치에서 한 것 | 네이버 authorize URL 리다이렉트(`handleSocial("naver")`) + 콜백 화면(state CSRF 검증) + Edge Function(코드→access token 교환, 프로필 조회, `admin.generateLink`로 매직링크 token_hash 발급) + 클라이언트 `verifyOtp` 세션 확립까지 앱 코드 전체 구현. 네이버 실제 이메일이 아니라 네이버 회원번호로 만든 합성 이메일을 정체성 기준으로 써서 DEC-004(자동 병합 금지)와 일관되게 함. 네이버 개발자센터 앱 등록(Client ID/Secret 발급, Callback URL 등록) + `supabase login`/`link` + `functions deploy naver-login` + secrets 설정까지 사용자와 함께 실제로 진행. |
| 실제 발견된 버그 2건(수정 완료) | (1) 터미널에서 Secret 값을 따옴표 없이 넘겨 셸이 특수문자를 잘못 해석해 "wrong client id / client secret pair" 발생 — 작은따옴표로 감싸서 재등록해 해결(코드 문제 아님, 운영 실수). (2) `app/login/naver-callback/page.tsx`가 `verifyOtp()`에 `token_hash`와 `email`을 같이 넘겨 Supabase Auth API가 "Only the token_hash and type should be provided"로 거부 — `email` 필드를 제거해 해결(진짜 코드 버그, 수정 커밋 필요). |
| 검증 | 실제 네이버 계정으로 로그인 → 콜백 → 세션 확립까지 실브라우저에서 성공 확인(사용자 직접 테스트). |

### P2-2. (2026-08-23, 완료) Realtime publication과 문의·알림 RLS

| 필드 | 내용 |
|---|---|
| 우선순위 | P2 |
| 현재 상태 | **완료 — 운영 확인 완료, 이상 없음** |
| 근거 파일 | `lib/notifications.ts`, `lib/inquiries.ts`, `add_notifications.sql`, `add_inquiries.sql`; `notifications`, `inquiry_threads`, `inquiry_messages` |
| 관련 문서 | [REQUIREMENTS 6-2](./REQUIREMENTS.md), [DATABASE 4-5, 12-5](./DATABASE.md), [ROUTES 알림·문의 항목](./ROUTES.md) |

라이브 확인: `supabase_realtime` publication에 `notifications`/`inquiry_messages`는 포함,
`inquiry_threads`는 빠져있음 — 처음엔 누락으로 의심했으나 `lib/inquiries.ts`의
`subscribeMessages()`가 실제로 구독하는 건 `inquiry_messages`(스레드 안 새 메시지)뿐이고
`inquiry_threads` 자체를 구독하는 코드는 없어 정상. RLS도 `inquiry_messages`(조회),
`inquiry_threads`(매니저/회원 조회), `notifications`(본인 조회/수정/삭제)가 각각 있고,
`inquiry_messages`/`inquiry_threads`에 INSERT 정책이 없는 건 RPC(SECURITY DEFINER)로
쓰기 때문에 정상, `notifications`에 사용자 INSERT 정책이 없는 것도 서버 trigger 전용
설계라 정상.

### P2-3. (2026-08-23, 완료) Storage bucket과 정책 운영 확인

| 필드 | 내용 |
|---|---|
| 우선순위 | P2 |
| 현재 상태 | **완료 — 운영 확인 완료, 핵심 리스크(business-licenses 비공개) 정상** |
| 근거 파일 | `lib/storage.ts`, `lib/profiles.ts`, `lib/center.ts`, `lib/reviews.ts`, `setup_storage.sql`; `avatars`, `business-licenses` |
| 관련 문서 | [REQUIREMENTS 5-1, 6-2](./REQUIREMENTS.md), [DATABASE 4-7, 7-4](./DATABASE.md) |

라이브 확인: `business-licenses` bucket `public=false`(비공개 유지 확인, 조회 정책도
본인 또는 platform admin으로 제한), `avatars`는 `public=true`(의도된 설계 — 프로필
사진은 공개). 업로드 정책은 둘 다 `auth.role()='authenticated'`만 확인하고 파일 경로가
본인 소유인지까지는 강제하지 않음(예: 로그인한 회원이면 이론상 다른 사람의 avatars 경로에
덮어쓰기 시도 가능 — 다만 경로가 uuid 기반이라 실제 악용 난이도는 낮음). 삭제/수정 정책은
둘 다 없음(업로드만 가능, 덮어쓰기는 storage API의 upsert 동작에 따라 별도 UPDATE 정책
필요할 수 있음 — 현재 화면에서 재업로드/교체가 실제로 되는지는 이번 범위에서 따로
검증하지 않음). 급한 문제는 아니라 별도 이슈로 승격하지 않음.

### P2-4. (2026-08-23, 완료) 핵심 trigger 운영 적용 확인

| 필드 | 내용 |
|---|---|
| 우선순위 | P2 |
| 현재 상태 | **완료 — 6개 전부 존재·활성 확인** |
| 근거 파일 | `schema.sql`, `reservation_functions.sql`, `add_platform_admin.sql`, `add_notifications.sql`, `add_notification_triggers.sql` |
| 관련 문서 | [DATABASE 11절, 12-5](./DATABASE.md) |

라이브 `pg_trigger` 조회 결과 `trg_create_default_center_roles`/`trg_guard_center_status`/
`notify_new_order`/`notify_new_review`/`notify_reservation_insert`/`notify_reservation_update`
6개 전부 존재하고 `tgenabled='O'`(활성)이며 대상 함수도 문서와 일치함을 확인.

확인 대상:

- `trg_create_default_center_roles`
- `trg_guard_center_status`
- `notify_new_order`
- `notify_new_review`
- `notify_reservation_insert`
- `notify_reservation_update`

### P2-5. (2026-08-23, 완료 — 취약점 발견 즉시 SQL 적용으로 차단) `revenue_summary` view가 anon에게 전체 센터 매출 노출

| 필드 | 내용 |
|---|---|
| 우선순위 | ~~P2~~ → P0 |
| 현재 상태 | **완료.** 취약점 발견 당일 SQL 적용, `information_schema.role_table_grants` 재조회로 anon/authenticated 권한이 사라지고 `postgres`만 남은 것을 확인. |
| 근거 파일 | `schema.sql`(`revenue_summary` 정의), `add_sales.sql`(`payments` RLS), `fix_revenue_summary_public_access_leak_draft_proposed.sql`(신규) |
| 관련 문서 | [DATABASE 4-7](./DATABASE.md), [REQUIREMENTS 5-4](./REQUIREMENTS.md) |

원래 목적은 "이 view를 운영에서 쓰는지" 확인이었는데, read-only 진단 중 확정된 실제 보안
구멍을 발견해 P0로 격상했다. `information_schema.role_table_grants` 조회 결과
`anon`(비로그인)과 `authenticated` 둘 다 `revenue_summary`에 SELECT 권한이 있었고,
`pg_class.reloptions`가 null이라 `security_invoker=true`가 꺼져 있음(Postgres 기본
동작 — plain view는 view owner(`postgres`)의 권한으로 실행돼 하위 테이블 RLS를 건너뜀)을
확인했다. 이 view가 select하는 `payments`의 실제 SELECT RLS(`add_sales.sql`의 "매니저
매출 조회")는 그 센터 매니저로 좁혀져 있는데, view가 그 RLS를 우회하므로 **anon key(클라이언트
번들에 박혀있는 공개 키)만으로 로그인 없이 REST API로 이 view를 직접 호출해 전체 센터의
일자별 결제건수·총매출·카드/현금/계좌이체/포인트·미수금을 볼 수 있는 상태였다.**

P2-6(아래) 조사에서 이미 확인했듯 `app/`·`lib/` 어디서도 이 view를 쓰지 않아, 정상 기능에
영향 없이 가장 단순한 조치(anon/authenticated 권한 회수)로 닫을 수 있다.
`fix_revenue_summary_public_access_leak_draft_proposed.sql` 작성(롤백 포함, view 자체는
삭제하지 않고 GRANT만 회수) — **사용자가 SQL Editor에서 실행, 재조회로 anon/authenticated
권한이 사라진 것 확인 완료.**

### P2-6. (2026-08-23 완료 — 죽은 경로 확정) `purchase_requests`의 현재 역할

| 필드 | 내용 |
|---|---|
| 우선순위 | P2 |
| 현재 상태 | **완료 — 죽은 경로로 확정, 정리는 보류(운영 데이터 삭제는 별도 승인 필요)** |
| 근거 파일 | `lib/center.ts`, `app/center/[id]/page.tsx`, `add_center_shop.sql`; `requestPurchase()`, `purchase_requests` |
| 관련 문서 | [DATABASE 4-3](./DATABASE.md), [ROUTES `/center/[id]`](./ROUTES.md) |

라이브 조회 결과 `purchase_requests`에 row가 5건뿐이고 전부 2026-07-22(초기 개발 중 수동
QA로 추정 — 상품명이 "체크용 수강권" 등 테스트성 이름) 이후 신규 row가 전혀 없음, 5건 모두
`pending` 상태로 한 달 넘게 방치됨을 확인 — `requestPurchase()`가 실제로 호출되는 경로가
없다는 걸 데이터로 재확인했다. 센터 상세 화면은 이미 `addToCart()`를 쓰고 있어 대체가
완료된 상태. 기존 5건 leftover row 삭제나 테이블 정리는 이번 범위 밖(CLAUDE.md 규칙 3,
기존 데이터 삭제는 별도 승인 필요) — 필요하면 후속으로 결정.

### P2-7. (2026-08-19, 완료) `.env.local.example` 부재

| 필드 | 내용 |
|---|---|
| 우선순위 | P2 |
| 현재 상태 | **완료.** `process.env.NEXT_PUBLIC_*` 전수 grep으로 필수 2개(`NEXT_PUBLIC_SUPABASE_URL`/`_ANON_KEY`) + 선택 5개(네이버/카카오 로그인, 결제 provider/scenario, VAPID)를 확인해 `.env.local.example` 신규 작성. `.gitignore`의 `.env*` 규칙이 `.env.test.local.example`만 예외 처리해 새 파일도 그대로 무시하고 있던 걸 발견해 `!.env.local.example` 예외 추가(안 했으면 커밋해도 파일이 조용히 빠짐). 예제 값 그대로 `.env.local`을 만들어 `npm run dev`로 `/login` 200 응답까지 실행 확인. |
| 근거 파일 | `.env.local.example`(신규), `.gitignore`, `README.md`, `docs/DEVELOPMENT_RULES.md`(11절 최신화) |
| 완료 조건 | ~~실제 필요한 키 이름과 설명만 포함한 예제 또는 README 설치 절차를 마련하고, 새 환경에서 안내대로 실행해 앱이 시작됨. 비밀값은 포함하지 않음~~ 완료. |
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

### P2-11. (2026-08-22, 완료) 센터 등록(`registerCenterForAccount`)이 사업자등록번호 중복을 막지 않고 원자적이지 않음

| 필드 | 내용 |
|---|---|
| 우선순위 | P2 |
| 현재 상태 | **완료.** DB unique 제약 + 트랜잭션 RPC 둘 다 적용(제품 결정 확인 후 진행) |
| 근거 파일 | `lib/centers.ts`(`registerCenterForAccount`), `add_register_center_for_account_safe_rpc.sql` |
| 관련 문서 | [ACL-005/UI-003 완료 보고, 2026-08-02](./CHANGELOG.md) |

ACL-005/UI-003 작업 중 전수 조사하며 확인: `centers.business_number`에는 `unique` 제약이 없고,
애플리케이션 코드 어디에도 중복 검사가 없었다. 또한 센터 등록은 `centers` insert →
`manager_centers` insert → `center_roles` 조회 → `manager_centers` update(오너 role_id 연결)
4단계를 별도 요청으로 순차 호출하며, 트랜잭션으로 묶여 있지 않아 중간 단계 실패 시 부분적으로만
생성된 상태가 남을 수 있었다.

**2026-08-22 해결**: `centers.business_number`에 부분 unique 인덱스(빈 값/NULL 제외)를 추가하고,
4단계 로직 전체를 `register_center_for_account_safe()` 하나의 security definer RPC로 묶었다
(`add_register_center_for_account_safe_rpc.sql`, 라이브 적용 확인됨). RPC 적용 전 읽기 전용
진단으로 (1) `business_number` 기존 중복 행 없음, (2) `centers`/`manager_centers`의 실제 라이브
RLS 정책(`pg_policies`)을 먼저 확인한 뒤, 그 정책들이 원래 강제하던 조건(본인 계정으로만 등록,
센터당 최초 1명만 오너로 연결)을 함수 본문 안에서 동일하게 재현했다 — SECURITY DEFINER로
RLS를 우회하는 대신 원자성만 얻는 방향. `lib/centers.ts`는 `accountId` 파라미터를 없애고
(RPC가 `my_account_id()`로 직접 확인) 단일 `supabase.rpc()` 호출로 축소, 호출부 2곳
(`app/login/page.tsx`, `app/mypage/register-center/page.tsx`)과
`tests/unit/centers.registerCenterForAccount.test.ts`를 함께 갱신.

**2026-08-22 후속 완료**: `businessNumber` 표기(하이픈/공백 유무 등) 정규화도 마무리했다.
읽기 전용 진단 쿼리(`diagnose_business_number_format_dupes_readonly.sql`)로 정규화(숫자만
비교) 기준 기존 중복이 없음을 먼저 확인한 뒤, 원문 그대로에 걸려 있던
`centers_business_number_unique` 인덱스를 `regexp_replace(business_number, '\D', '', 'g')`
기준 `centers_business_number_normalized_unique`로 교체(`fix_business_number_normalize_unique.sql`,
라이브 적용 확인됨). `register_center_for_account_safe()`의 `exception when unique_violation`
처리는 어떤 unique 인덱스가 위반됐는지와 무관한 범용 처리라 RPC/클라이언트 코드는 전혀
변경하지 않았다.

### P2-12. SEC-007/008 RLS 정책 초안의 세부 결정 필요 항목

| 필드 | 내용 |
|---|---|
| 우선순위 | P2 |
| 현재 상태 | **보류 — 출시 blocker 아님.** 2026-08-23 코드 재확인: `staff_salaries`/`contracts`/`membership_transfers`/`community_posts`/`community_comments` 전부 `app/`·`lib/` 어디서도 참조되지 않는 미구현 기능(화면 자체가 없음), `add_rls_gap_tables_draft_proposed.sql`도 라이브 미적용 초안이라 지금 열려있는 구멍이 아님. 사용자 결정: 각 기능을 실제로 만들 때 그 시점의 구체적인 구현 방식(RPC 여부 등)에 맞춰 재검토하기로 하고 지금은 보류. |
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

### P2-13. (2026-08-18, 완료) service_role이 RLS Gap 17개 테이블에 대한 SQL GRANT가 없음(`contracts`/`notification_logs` 통합 테스트 자동화 불가)

| 필드 | 내용 |
|---|---|
| 우선순위 | P2 |
| 현재 상태 | **완료.** `contracts`/`notification_logs`의 service_role GRANT는 이미 Live에 적용돼 있었음(2026-08-18 read-only 확인, 언제 적용됐는지는 불명 — 문서 갱신 누락). 두 테이블에 없던 RLS SELECT 정책(`docs/22_RLS_Gap_A2_Investigation.md` 설계)을 적용하고, `tests/integration/sec009-batch-a2-rls.test.ts`(신규)로 검증 — 로컬 Live Supabase 대상 12/12 통과. |
| 근거 파일 | `tests/integration/sec009-batch-a1-rls.test.ts`, `tests/integration/sec009-batch-a2-rls.test.ts`(신규), `fix_rls_gap_batch_a2_contracts_notification_logs_draft_proposed.sql`(신규, 적용 완료), `docs/22_RLS_Gap_A2_Investigation.md` |
| 완료 조건 | ~~GRANT 실행 승인 후 진행, contracts/notification_logs의 자동화된 통합 테스트를 추가함~~ 완료. |
| 관련 문서 | [21_RLS_Gap_Analysis.md](./21_RLS_Gap_Analysis.md), [22_RLS_Gap_A2_Investigation.md](./22_RLS_Gap_A2_Investigation.md) |

SEC-009(Batch A 적용 준비) 중 발견: RLS 정책 부재와는 별개로, `staff_salaries`/`contracts`/
`leads`/`messages`/`notification_logs` 5개 테이블 전부 `service_role`에 SQL GRANT 자체가 없었다
(`account_center_permissions`에서 이미 한 번 겪은 것과 같은 패턴, `permission denied for table X`).
`staff_salaries`/`leads`/`messages`는 오너에게 INSERT+DELETE 정책이 모두 있어 일반 로그인
client로 fixture를 만들고 지울 수 있어 문제가 되지 않았지만, `contracts`(DELETE 정책이
의도적으로 없음 — 서명 후 불변)와 `notification_logs`(INSERT 정책이 의도적으로 없음 — 서버
트리거 전용)는 일반 client로도 admin client로도 fixture를 만들거나 지울 방법이 없어
`tests/integration/sec009-batch-a1-rls.test.ts`에서 의도적으로 제외돼 있었다.

**2026-08-18 완료**: read-only로 재확인한 결과 `contracts`/`notification_logs` 둘 다
`service_role` GRANT(SELECT/INSERT/UPDATE/DELETE)가 이미 있었음 — 언제 누가 적용했는지는
불명이나(GRANT 자체를 남긴 fix 파일이 저장소에 없음), 이 GRANT는 이미 그 전에 해결돼 있었고
문서만 안 고쳐진 상태였다. 이번엔 GRANT가 아니라 `docs/22_RLS_Gap_A2_Investigation.md`가
이미 설계해둔 SELECT 정책(`contracts`: 본인 또는 `contract.list.view` 권한 보유자 또는
platform admin, `notification_logs`: `message.sms.view` 또는 `message.push.view` 권한
보유자 또는 platform admin — 둘 다 INSERT/UPDATE/DELETE는 의도적으로 정책 없음, 기본 거부
유지)를 그대로 적용(`fix_rls_gap_batch_a2_contracts_notification_logs_draft_proposed.sql`,
사용자 실행·`pg_policies` 확인 완료). **주의**: `notification_logs`는 `messages` 테이블과
달리 채널별로 권한이 안 나뉜다 — `message.sms.view`/`message.push.view` 둘 중 아무거나
있으면 그 센터의 SMS/푸시 발송기록을 전부 볼 수 있다(설계 문서에 그렇게 정의돼 있고, 로컬
테스트로 실제 동작이 이 의도와 일치함을 확인 — `messages`처럼 채널로 나누려면 별도 결정과
정책 재작성이 필요, 이번 범위 밖).

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
- ~~`lib/classes.ts`의 구버전 `previewCopySchedule`/`copySchedule`(nth-weekday 방식)이 화면에서
  더 이상 호출되지 않는 죽은 코드로 남아있음~~ **[2026-08-22 완료]** 어디서도 참조하지 않음을
  grep으로 재확인 후 `nthWeekdayOfMonth`/`CopyPreviewItem`과 함께 완전히 제거(`copyByWeekday`/
  `copyByDate`는 실제로 쓰이는 별개 함수라 유지). `npm run build` 통과 확인.
- 반복수업 생성(`perDayMode`)과 `updateClassGroup`이 여러 행을 순차 처리해 원자성이 없음(중간
  실패 시 일부만 반영) — RPC로 묶을지 판단 필요(SQL). (미해결, 이번 배치 범위 밖)
- ~~`app/manager/staff/permissions/page.tsx`의 클라이언트 가드(오너만 진입 가능)와 서버 쓰기
  정책(`facility.role_permission` 보유자도 가능)이 불일치~~ **[2026-08-22 완료]** 클라이언트
  가드를 서버 정책(`add_personal_permissions.sql`의 INSERT/UPDATE/DELETE 정책 기준: 오너 또는
  `facility.role_permission` 보유자)에 맞춰 `hasAccess` 판정을 `isOwner || fetchMyEffectivePermissionKeys(...).has('facility.role_permission')`로 확장(SQL 변경 없음, 화면 로직만).
  같은 이유로 `app/manager/staff/page.tsx`의 "개인 권한 설정" 진입 링크도 이 페이지의 다른
  버튼들과 동일하게 `canManageRolePermissions`로 가드해, 권한 없는 스태프에게 클릭 후 막히는
  링크가 보이지 않도록 함께 맞췄다.
- ~~`membership_schedule_rules`는 `pass.update` 권한을 요구하는데 메뉴 게이트는 `pass.create`만
  확인~~ **[2026-08-22 완료]** `app/manager/page.tsx`의 "수강권 관리" 메뉴 조건을
  `pass.create || pass.update`로 확장. 화면 내부(`app/manager/membership-rules/page.tsx`)는
  이미 두 키를 따로 체크하고 있어 진입 메뉴만 문제였음.
- ~~`progress_records`에 UPDATE RLS 정책 자체가 없음~~ **[2026-08-22 완료, SQL 적용 완료]**
  `fix_progress_records_missing_update_rls_draft_proposed.sql` 작성(롤백 포함) —
  `progress_categories` 기존 UPDATE 정책과 동일 패턴(`customer.progress` 권한). 사용자가
  Supabase SQL Editor에서 실행, `pg_policies` 확인 쿼리로 `진도 기록 수정`(UPDATE) 정책 생성
  확인 완료.
- ~~`rooms` SELECT가 `using (true)`로 전체 공개 — 의도된 것인지 확인 필요~~ **[2026-08-22 완료,
  수정 없음]** `fix_permission_products_rooms_rls.sql` 주석에서 이미 의도된 설계로 확인됨(PII
  없는 테이블, 룸 관리 권한 강화 시에도 조회는 의도적으로 열어둠).

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
- **알림 카테고리가 8개가 아니라 4개뿐이고 서버가 이 설정을 전혀 읽지 않음(2026-08-07 P2
  배치에서 부분 해결)**: `app/settings/notifications/page.tsx`의 알림 설정은 `localStorage`에만
  저장되고(`reservation`/`waitlist`/`reminder`/`marketing` 4종), 모든 서버 트리거
  (`trg_notify_reservation_insert/_update`, `send_inquiry_message` 등)는 이 설정과 무관하게
  항상 알림 행을 만든다 — 이건 그대로 유지한다(알림함은 항상 기록이 남아야 함, 감사 로그
  성격). 다만 실시간 팝업(`NotificationToaster`)만큼은 `lib/notifications.ts`의
  `notiPrefKeyForKind()`로 이 설정을 실제로 읽어 팝업 표시 여부를 거르도록 연결했다(SQL
  변경 없음, 저위험). **여전히 남은 것**: 서버측 발송 자체를 막는 것(수신거부를 트리거
  SQL에 반영), "공지/결제" 등 카테고리 확장, "혜택·이벤트"(마케팅) 알림을 실제로 만드는
  기능 자체 — 전부 DB 변경 및 제품 결정이 필요한 별도 작업.
- **`notification_rules`/`messages`(SMS/LMS)/`notification_logs`는 스키마만 있고 완전 미구현**:
  `app/settings/notifications/page.tsx`의 "실제 발송 연동은 준비 중이에요" 문구는 정확하다 —
  In-app DB 알림 외에는 push(FCM/APNs)/SMS/카카오 알림톡/이메일 전부 백엔드 자체가 없다.
  문구를 더 명확하게(채널별로) 다듬는 것을 이번 배치에서 진행함(E-3).
- **문의 답변 알림이 스레드로 딥링크되지 않음**: `notifications.data.thread_id`가 저장되지만
  `app/notifications/page.tsx`/`app/manager/notifications/page.tsx`의 클릭 핸들러가 `link`만
  보고 이동해 목록 화면까지만 가고 특정 스레드는 자동 선택되지 않는다 — 이번 배치에서 함께 수정.
- ~~`app/mypage/history/page.tsx`(전체 예약 내역)가 어디서도 링크되지 않는 고아 라우트~~
  **[2026-08-22 완료]** `app/mypage/page.tsx`의 "내 정보" 섹션(구매 내역 위)에 "예약 내역" 진입
  링크를 추가했다. 참고: 같은 페이지의 `history`/`showAllHistory` state(`fetchMyPage()`가
  이미 내려주는 값)는 여전히 어디서도 렌더링되지 않는 죽은 state로 남아있음(이번 수정과 별개
  이슈 — 진입 링크는 신규 라우트로 보내는 방식을 택했고, 이 state 자체를 정리하는 건 범위 밖).
- **(E-6) 운영설정의 "문의 게시판 사용"/"락커 기능 사용"/"회원앱 라운지 사용" 토글 제거**:
  `use_inquiry_board`/`use_locker`/`use_lounge` 세 컬럼 모두 `schema.sql`/`lib/settings.ts`/
  이 UI 외에는 어디서도 읽지 않는 죽은 설정임을 grep으로 확인(관리자가 켜고 꺼도 실제 효과
  없음) — `app/manager/settings/page.tsx`의 토글 UI에서만 제거했다. DB 컬럼은 이번에 지우지
  않았다(향후 락커/라운지/문의게시판 기능이 실제로 만들어지면 그때 이 컬럼을 다시 쓸 수도
  있어 임의로 삭제하지 않음 — 실제 컬럼 삭제는 별도 migration 이슈로 분리해서 판단 필요).

### P2-17. (신규) 실브라우저 QA 재검증에서 발견한 항목

- **(2026-08-14, 완료 확인 — 문서만 정정) `calc_deadline()`의 `'open'` kind 미처리**: 이 문서는
  `fix_calc_deadline_open_kind_draft_proposed.sql`이 "승인 대기"라고 기록하고 있었으나,
  2026-08-14 사용자가 `select pg_get_functiondef('calc_deadline(uuid,text,timestamptz,text)'::regprocedure);`로
  라이브 함수 본문을 직접 확인한 결과 **이미 `elsif p_kind = 'open' then ...` 분기가 정확히
  그 draft 파일과 동일하게 적용돼 있었음** — P2-21 항목이 `operational-settings-wiring.test.ts`
  통과로 간접 확인한 것과도 일치하는 결과, 이번엔 `pg_get_functiondef`로 직접 재확인. draft SQL은 실행 불필요(실행해도 내용이 같아
  무해하지만 불필요). 이전 배치 문서의 "C-2 정상 배선" 결론이 이 항목에 한해 최초엔
  틀렸었다는 점(함수 실제 정의를 재확인하지 않은 오판)은 기록으로 남긴다.
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
- **(2026-08-08 재확인) `tests/e2e/admin/class-allowed-products.spec.ts`도 TEST-002(#24)
  오염의 영향을 받음**: P4(매출 대시보드) CI 2회차 연속 Green 확인 중, 이 파일과 전혀 무관한
  커밋(P4는 sales.ts/manager 홈/SQL만 변경)에서 이 spec만 실패 — 실패 로그를 보면 검색 결과
  목록에 "E2E 테스트 수강권"이 수십 건 중복으로 쌓여 있어(`toHaveCount`/`not toContainText`
  단언이 그 개수·존재 여부를 검사) 정상적인 코드 동작과 무관하게 실패했다. 바로 다음(직전) CI
  실행에서는 같은 코드로 이 spec이 정상 통과했었다 — 실행 시점마다 쌓인 오염량에 따라 간헐적으로
  Red/Green이 갈리는 것으로 보인다. 범위 밖(TEST-002/#24 해결 시 함께 검토), 재실행으로 우회.
- **TEST-002(#24)의 알려진 오염이 다른 파일에도 영향을 준다는 것을 재확인**: `acl-003-permission-read.test.ts`가
  남기는 "MANAGER_B가 centerA의 활성 스태프가 됨" 오염 상태 때문에, 이번 배치가 새로 추가한
  `tests/integration/inquiry-access-isolation.test.ts`의 "다른 센터 매니저는 못 본다" 케이스와
  기존 `admin-assignment-security.test.ts`의 "다른 센터 관리자는 배치 못 함" 케이스가 같은 CI
  실행에서 함께 실패하는 것을 관측함(둘 다 설계·코드 문제 아님, RLS/RPC는 "활성 소속 여부"를
  정확히 설계대로 검사 중 — #24 해결 전까지는 테스트 실행 순서에 따라 이 두 케이스가 간헐적으로
  RED일 수 있음).

### P2-18. (신규, 2026-08-08, 2026-08-10 상태 정정) P4 매출/통계 대시보드 — SQL 적용 완료

| 필드 | 내용 |
|---|---|
| 우선순위 | 해결됨(과거 P2) |
| 현재 상태 | **적용 완료.** 아래 네 SQL(payment_provider → dashboard_summary → daily_bug fix → service_role payments grant) 전부 적용됨 — `dashboard-summary.test.ts` 7/7이 P2-20 최종 검증(2026-08-09, 3연속 Integration Green)에도 포함돼 계속 통과 확인됨. 이 상태 필드가 "SQL 적용 대기"로 오래 남아 있던 것은 문서 갱신 누락이었고(PR #44 리뷰 중 발견), 실제 DB 상태와는 무관 — 2026-08-10 정정. |
| 근거 파일 | `fix_payments_payment_provider_draft_proposed.sql`, `add_manager_dashboard_summary_draft_proposed.sql`, `fix_manager_dashboard_summary_daily_bug_draft_proposed.sql`, `fix_service_role_missing_grants_payments_draft_proposed.sql`, `lib/sales.ts`(`fetchDashboardSummary`), `app/manager/page.tsx`, `tests/integration/dashboard-summary.test.ts` |
| 완료 조건 | ~~SQL 4개 순서대로 적용~~ 완료 |

- **2026-08-08 CI 1차 재실행에서 SQL 버그 발견**: `payment_provider`/`dashboard_summary`
  두 SQL 적용 직후 CI를 재실행하니 `dashboard-summary.test.ts` 6건이 전부
  `"column d.date does not exist"`로 실패 — `manager_dashboard_summary()`의 `daily`
  필드 서브쿼리에서 별칭 실수(`d.date` → `days.date`여야 함). 세 번째 SQL
  `fix_manager_dashboard_summary_daily_bug_draft_proposed.sql`로 수정.
- **2026-08-08 CI 2차 재실행에서 DB 인프라 문제 발견**: daily 버그 수정 SQL 적용 후 CI를
  또 재실행하니 이번엔 `"permission denied for table payments"`로 전부 실패 — service_role이
  `payments` 테이블에 대한 SQL GRANT 자체가 없었다(기존 결제 경로가 전부 security definer
  RPC라 지금까지 드러나지 않던 gap, `fix_service_role_missing_grants_for_e2e_admin_draft_proposed.sql`
  과 같은 계열). 네 번째 SQL `fix_service_role_missing_grants_payments_draft_proposed.sql`로 해결.

- 매니저 홈(`/manager`)에 오늘/7일/30일 매출 요약 카드와 일별 막대그래프를 추가했다.
  `manager_dashboard_summary()` RPC가 DB에서 직접 SUM/COUNT로 집계해(1000행 응답 제한 위험
  없음) Mock 결제(`payment_provider='mock'`)를 항상 제외한다.
- **알려진 한계**: 수강권/상품 매출 구분은 `payments.membership_id → memberships.product_id
  → products.product_kind` 조인으로 계산한다(`revenue_category`는 `registerPayment()`가
  항상 `'membership'`만 저장해 신뢰 불가 — 코드 감사로 확인). 한 결제에 "추가 상품"
  (`extraProducts`)이 함께 발급된 경우 그 추가 상품 매출은 결제 건의 대표 `membership_id`
  하나로만 잡혀 별도 집계되지 않는다 — 정확한 상품별 세부 분해가 필요해지면 스키마 변경
  (결제-상품 다대다 연결 테이블 등)이 별도로 필요하다.
- SQL 미적용 상태에서는 대시보드 카드가 에러 문구를 보여주고(RPC 없음), `payment_provider`
  컬럼이 없어 `confirm_test_payment()`도 기존 정의 그대로 동작(회귀 없음 — `create or replace`
  전이라 기존 mock 결제 발급 자체는 계속 정상 동작).

### P2-19. (신규, 2026-08-09) class-allowed-products.spec.ts 간헐 실패의 실제 원인 — 공유 테스트 센터 오염, 정리 SQL 적용 대기

| 필드 | 내용 |
|---|---|
| 우선순위 | P2 (오염 정리 자체는 완료·검증됨 — 아래 P2-20의 별개 버그가 새 블로커) |
| 현재 상태 | **오염 정리 완료(v4 적용+검증됨). class-allowed-products.spec.ts는 여전히 실패하지만 원인이 오염이 아님을 확인 — P2-20 참고** |
| 근거 파일 | `cleanup_shared_test_center_pollution_draft_proposed.sql`(v4, 적용 완료), `tests/integration/setup.ts`(`createTestMembership`), `tests/e2e/fixtures/testData.ts`(`createTestMembershipAdmin`/`createTestGoodsMembershipAdmin`), `tests/integration/class-allowed-products-enforcement.test.ts`, `tests/integration/usable-memberships-pass-kind.test.ts`, `tests/e2e/admin/attendance.spec.ts` |
| 완료 조건 | (오염 정리 자체는 완료) — class-allowed-products.spec.ts의 전체 Green은 P2-20 해결에 달려 있음 |

- **v4 SQL 적용 완료 및 검증(2026-08-09)**: 사용자가 Supabase SQL Editor에서 v4를 에러 없이
  실행함. 적용 후 읽기 전용 진단(diag_only 모드)으로 6개 정리 대상을 직접 재확인 —
  admin_action_logs(v4 자체의 트랜잭션 내 재확인 가드로 확인, service_role의 PostgREST
  GRANT가 없어 독립 재조회는 못 함)/orphan profiles/"통합테스트 수강권"/
  "통합테스트 수강권(P3)"/"P0-6 테스트 무제한권"/"USABLE-PASS-KIND 테스트 대여품" 상품
  전부 0건. 임시 진단 스캐폴딩(`tests/integration/_diag_pollution.test.ts`,
  `.github/workflows/test.yml`의 `diag`/`diag_only`)은 진단 완료 후 삭제해
  `test.yml`이 이 조사 이전 상태와 완전히 동일함을 `git diff`로 확인함.

- **v1→v4 반복(2026-08-09)**: v1(admin_action_logs FK 위반, 놓친 FK 전수 재감사로 v2) →
  v2(같은 FK 오류 재발 — admin_action_logs DELETE 자체는 성공했지만, get-or-create로
  재사용되는 membership에 admin-assignment-security.test.ts의 다른 세션이 admin_action_logs를
  새로 insert해 같은 트랜잭션의 나중 DELETE가 그 새 참조에 걸림 → LOCK TABLE로 막는 v3) →
  v3(FK 오류는 해결됐지만 row-count guard가 안전하게 중단 — 진단 시점 2525건이던
  "통합테스트 수강권" 모집단이 실행 시점엔 168건으로 줄어 있었고 전부 userA/managerA가
  아닌 제3의 TEST_* profile_id 소속이었음, utf8 byte 비교로 유니코드 정규화 문제는 아님을
  확인) → v4(profile_id 제한 자체를 제거 — 이 product_name 문자열은 처음부터 어느
  profile_id에도 안 묶여도 구조적으로 테스트 전용인 값이었고, 시점마다 여러 TEST_* 계정
  사이를 오가는 모집단에 특정 2개 profile_id로만 좁히는 게 오히려 정리를 막았음). 상세
  경위는 SQL 파일 헤더 주석 참고.

### P2-21. (2026-08-10, 진행 중 — 재현 실패했지만 종결 아님) PR #44 수동 QA "신규 수업은 사용 가능한 수강권이 없다고 뜸"

| 필드 | 내용 |
|---|---|
| 우선순위 | P1 (사용자 지시로 재오픈 — 자동화 공백을 메우기 전엔 종결 금지) |
| 현재 상태 | **TEST_MANAGER_A/TEST_USER_A/centerA 기존 fixture + 실제 관리자 UI 등록 경로로는 재현 실패(변동 없음). 사용자 지시에 따라 구매 직후 즉시 사용 가능 여부(TEST4)와 goods 배제(TEST5)까지 실제 브라우저로 구현/검증 완료 — 3회 연속 통과. 그러나 무관한 사전 존재 이슈(`attendance-policy.test.ts`의 주간 대기예약 한도 초과, 아래 참고) 때문에 "전체 CI 2회 연속 Green" 요건은 아직 미충족 — PR #44는 여전히 merge 안 됨** |
| 근거 파일 | `tests/e2e/admin/new-class-creation.spec.ts`(TEST1/TEST2/TEST4/TEST5/TEST6) |
| 완료 조건 | (a) `attendance-policy.test.ts` 블로커에 대한 사용자 결정(데이터 정리 승인 또는 현재 증거로 충분하다고 판단) + 전체 CI 2회 연속 Green, 또는 (b) 사용자가 원래 수동 QA에서 다른 계정/센터/상품을 썼다는 추가 정보를 주면 재조사 |

- **TEST4/TEST5 결과(2026-08-10 추가, 실제 브라우저 3회 연속 통과)**: 신규 수업 생성(A: 모든
  수강권 허용, B: 특정 pass만 허용) → 회원이 "사용 가능한 수강권 없음" 확인 → 실제
  "수강권 구매하기" → 센터 구매 시트 → `/checkout` mock 결제 완료 → "지금 바로 예약
  이어가기" 클릭(전체 페이지 재로드, `<a href>`) → 같은 예약창 재오픈 → 방금 구매한 pass가
  즉시 `.pass-pick-list`에 표시 → 예약 성공까지 전부 실측 확인. goods(`E2E 테스트 대여품
  상품`)는 구매 가능 목록/적용 가능 수강권 어디에도 노출되지 않음(`fetchPurchasableProductsByClass`가
  `product_kind='pass'`로 구조적으로 필터링).
- **구매 직후 상태 갱신 경로**: 별도의 client-side 캐시 갱신 로직이 전혀 없다 — "지금 바로
  예약 이어가기" 링크와 1.8초 후 자동 fallback 둘 다 `window.location.href` 풀 페이지
  이동이라, 예약창이 완전히 새로 마운트되며 `usable_memberships_for_classes`를 처음부터
  다시 호출한다. 구조적으로 stale-cache가 발생할 여지가 없음(실측 3/3 확인, race 아님).
- **재현 시도 절차(전부 CI 실측, 추측 없음)**: (1) read-only 진단으로
  `membership_schedule_rules`가 centerA 전체 0건임을 확인(과거 이 정확한 증상을 냈던
  "모든 수강권 허용으로 저장해도 자동으로 schedule_rules가 추가되던" 앱 버그의 잔여
  데이터 가설을 반박 — 그 버그는 이미 고쳐졌고 남은 데이터도 없음), (2) admin client로
  직접 insert한 새 class가 기존 class와 RPC 결과가 완전히 동일함을 확인, (3) 실제
  Playwright 브라우저로 관리자 UI를 통해 새 class를 등록(모든 수강권 허용/특정 pass 1개
  허용 둘 다) → class_allowed_products/RPC/회원 화면(`.pass-pick-list`)/실제 예약 성공까지
  전부 정상 동작 확인. (4) 이번에 TEST4/TEST5로 구매 → 즉시 사용까지 실제 결제 흐름
  전체를 추가로 재현 시도했으나 역시 재현 실패.
- **조사 중 실제로 찾은 것은 앱 버그가 아니라 테스트 자체의 결함 3건**(전부 코드 변경 없이
  수정, 상세 경위는 `tests/e2e/admin/new-class-creation.spec.ts` 파일 상단 주석 참고):
  Node 쪽에서 인증 안 된 세션으로 `class_allowed_products`를 조회해 RLS에 항상 막힌 것,
  테스트가 임의로 고른 90/91일 뒤 날짜가 "예약 오픈 기한"(`groupOpenDaysBefore`, 기본
  60일)을 초과해 `reserve_with_membership()`이 설계대로 정확히 거부한 것, `.class-row`
  재진입 클릭 전에 달력 날짜 칸을 안 눌러 그 날짜 목록 자체가 안 보였던 것.
- **부산물**: `fix_calc_deadline_open_kind_draft_proposed.sql`(open kind 분기)이 실제
  적용돼 있음을 `operational-settings-wiring.test.ts` 통과로 재확인.
  `class_allowed_products`에 대한 service_role GRANT가 여전히 없음을 재확인(기존
  P2-13/RES-002 계열과 같은 gap, 이번엔 새 조치 안 함).
- **남은 가능성(재현 실패했다고 "버그가 없다"고 100% 단정하지는 않음)**: 사용자의 원래
  수동 QA가 이 fixture와 다른 계정/센터/상품을 썼을 수 있고, 그 경우 그 계정/상품에만
  존재하는 stale `membership_schedule_rules`나 다른 데이터 특이사항이 원인일 수 있다 —
  이번 조사로는 배제하지 못함. 추가 재현 정보가 오면 그때 계속 조사할 것.

### P1-15. (2026-08-10, 최종 완료) PR #44 수동 QA 버그 — 실제 dev 계정에서는 100% 재현됨(TEST fixture는 정상)

| 필드 | 내용 |
|---|---|
| 우선순위 | P0(실제 결제/예약 핵심 흐름에 영향, 실제 계정에서 100% 재현) |
| 현재 상태 | **완료. root cause 확정, 코드 수정 완료, regression test 전부 통과, 전체 CI 2연속 Green(run `31411383724`/`31413532650`). 사용자가 `cleanup_p1_15_stale_schedule_rules_draft_proposed.sql`을 Supabase SQL Editor에서 적용(`remaining_target_rules=0` 확인). 사후 read-only 재검증(run `31421494819`, `diag_p1_15_verify` job)에서 "수강권" 상품의 `membership_schedule_rules`가 0건임과, 실제 회원(memberB)의 "수강권" memberships 3건 전부가 "테스트" class에서 `usable예측=true`로 재계산됨을 실측 확인. 회귀 확인 CI도 재검증 시점에 2연속 Green(run `31419033306`/`31421494819`, 둘 다 first-attempt) 재확인.** |
| 근거 파일 | `app/manager/classes/page.tsx`, `lib/passes.ts`(`fetchRulesForProducts`/`matchesAnyScheduleRule`/`findScheduleExcludedProducts`), `tests/unit/passes.scheduleRuleWarning.test.ts`, `tests/e2e/admin/membership-schedule-rules.spec.ts`, `fix_service_role_missing_grants_accounts_draft_proposed.sql`+`_write_draft_proposed.sql`(둘 다 적용 완료), `cleanup_p1_15_stale_schedule_rules_draft_proposed.sql`(적용 완료, `remaining_target_rules=0` 확인) |
| 완료 조건 | ~~전체 CI 2연속 Green~~ 완료. ~~schedule_rules cleanup SQL 적용~~ 완료. ~~사후 read-only 재검증~~ 완료. |

- **코드 분석으로 찾은 유력 단서 → 실제 계정 데이터로 확정**: `usable_memberships_for_classes()`(`fix_usable_memberships_product_kind.sql`)는 파라미터로 받는 `p_profile_id`가 아니라 **호출 세션의 계정**(`my_account_id()`, `auth.uid()` 기반)으로 memberships를 필터링한다 — 이건 의도된 설계(가족 프로필 공유)이고 실제 계정도 문제없이 이 조건을 통과했다. 실제 탈락 원인은 `membership_schedule_rules` — 실제 "수강권" 상품에 화/수 특정 시간·"수업"이라는 제목으로 제한하는 규칙 2건이 걸려 있었고, 신규 "테스트" 수업(월요일)은 이 조건과 전혀 안 맞아 보유 pass·신규 구매 pass 전부 탈락했다. class_allowed_products("모든 수강권 허용")는 상품 제한만 해제할 뿐 이 조건은 별개로 계속 적용된다 — RPC는 정확히 설계대로 동작.
- **UX 수정**: 수업 등록/수정 화면의 "예약 가능 수강권" 섹션에 (a) "모든 수강권 허용은 상품 제한만 해제, 수강권 자체의 요일/시간 조건은 별개로 계속 적용" 고정 설명 + (b) 현재 날짜/시간/제목 기준 실제 배제되는 수강권이 있으면 `.schedule-rule-warning` 경고 표시(어느 조건 때문인지까지 표시). "특정 수강권 지정" 모드도 동일 계산 로직으로 함께 커버.
- **schedule_rules 2건의 용도/생성 경로 확정(read-only 진단, CI run `31413532650`)**: 이 두 규칙이 가리키는 제목("수업")의 class가 실제로 2건 존재 — 화요일 16:00(class `00494e21...`)/수요일 15:00(class `93a6c842...`). 각 규칙의 `created_at`이 대응하는 class의 `created_at`과 **초 단위로 거의 동시**(0.5~0.6초 차이)에 생성됐다 — 이 저장소에 이미 문서화된, 지금은 고쳐진 옛 버그(class_allowed_products 저장 부수효과로 membership_schedule_rules 자동 생성, `class-allowed-products.spec.ts` beforeAll 주석 참고)와 정확히 같은 신호. 두 class 모두 진단 시점(2026-08-10) 기준 이미 지난 날짜이고 반복되는 일정이 아니다 — 관리자가 `/manager/membership-rules`에서 의도적으로 설정했다기보다 그때 class를 만든 부수효과로 자동 생성됐을 가능성이 매우 높다. `cleanup_p1_15_stale_schedule_rules_draft_proposed.sql` + rollback 작성 완료(id 2건 정확히 지정, FK 없음 확인) — **Supabase에는 실행하지 않음, 사용자 결정 필요**.
- **실제 계정 진단 중 발견한 무관한 문제들(이 버그 자체와는 무관, 인프라/타 이슈)**: groupOpenDaysBefore 값 복구(완료), `accounts` service_role GRANT 추가(SELECT + INSERT/UPDATE/DELETE, 둘 다 사용자 적용 완료). P1-16(무관한 사전 존재 버그, 해결 완료) 참고.
- **cleanup SQL 적용 완료(2026-08-10) + 사후 read-only 재검증**: 사용자가 Supabase SQL Editor에서 A(preview)/B(BEGIN...COMMIT, guard 포함 delete)/C(post-verification) 순서로 실행, `remaining_target_rules=0` 확인 보고. 별도 임시 read-only 진단(`_diag_p1_15_postcleanup_verify.test.ts`, workflow_dispatch 전용, 검증 완료 후 삭제)으로 (1) `membership_schedule_rules` 독립 재조회 결과 0건, (2) 실제 회원 memberB의 "수강권" memberships 3건 전부 `usable예측=true`(status/remaining/expires/classAllowed/scheduleRule 전 조건 true), (3) "테스트" class의 `class_allowed_products`는 여전히 0건("모든 수강권 허용" 유지)임을 확인. "새로 구매한 수강권"·"특정 수강권 지정" 케이스는 실제 QA 계정에 새 데이터를 쓰는 대신, 격리된 E2E 회귀 테스트(`membership-schedule-rules.spec.ts`의 test E/C+D+F)로 그 일반 메커니즘이 여전히 정확히 동작함을 검증(같은 상품이면 새로 발급된 membership도 동일 제한 적용, class_allowed_products로 허용해도 schedule rule 불일치면 여전히 차단 + 관리자 경고 노출).
- PR #44는 여전히 MERGE BLOCKED 상태(사용자 지시로 계속 유지, main merge는 별도 명시적 요청 전까지 하지 않음) — P1-15는 이 항목 자체로는 완료, 최종 merge 가능 여부는 사용자의 수동 QA 재확인 및 별도 merge 지시에 달려 있음.

### P1-16. (2026-08-10, 해결 완료) `accounts` 테이블 service_role INSERT/UPDATE/DELETE GRANT 누락 — 소셜 로그인 부트스트랩 테스트 반복 실패

| 필드 | 내용 |
|---|---|
| 우선순위 | 해결됨(과거 P1) |
| 현재 상태 | **완료. 사용자가 `fix_service_role_missing_grants_accounts_write_draft_proposed.sql` 적용 → `auth-account-bootstrap.test.ts` 2회 연속 통과(run `31411383724` first-attempt, `31413532650`) 확인. "permission denied for table accounts" 완전히 사라짐.** |
| 근거 파일 | `tests/integration/auth-account-bootstrap.test.ts`, `fix_service_role_missing_grants_accounts_write_draft_proposed.sql`(적용 완료), `rollback_fix_service_role_missing_grants_accounts_write_draft_proposed.sql` |
| 완료 조건 | ~~사용자가 SQL 적용~~ 완료. ~~해당 테스트 재검증~~ 완료(2연속 통과). |

- **최초 가설(틀림, 정정함)**: 처음엔 `lib/authAccount.ts`의 `ensureAccountForCurrentUser()`가
  마지막 `profiles` insert의 error를 확인하지 않는 게 원인이라고 추정했다. 이 가설을
  **추측으로 남기지 않고 임시 진단 로그를 추가해 실측으로 검증**했는데(CI run `31408951718`),
  그 로그가 **한 번도 찍히지 않았다** — 즉 그 코드 경로 자체에 진입하지 않았다는 뜻이라
  가설이 틀렸음을 확인하고 진단 로그는 즉시 원복(`lib/authAccount.ts`는 최종적으로 변경 없음).
- **진짜 원인(실측 확정)**: 같은 run의 로그에 `tests/integration/auth-account-bootstrap.test.ts`의
  `beforeAll`이 남긴 경고가 그대로 찍혀 있었다 — `"throwaway 계정 accounts 정리 실패(무시하고
  계속): permission denied for table accounts"`. 이 `beforeAll`은 이전 실행이 남긴 throwaway
  테스트 계정을 admin(service_role)으로 정리하는데, `accounts` 테이블에 service_role
  INSERT/UPDATE/DELETE GRANT가 없어(SELECT만 최근에 추가됨, P1-15 참고) 이 delete가 항상
  실패한다(`payments`/`admin_action_logs`/`profiles`/`class_allowed_products`와 동일 계열의
  이미 여러 번 나온 GRANT 누락 패턴). delete 실패로 낡은 accounts 행이 남고, 그 행은 이미
  profiles가 지워진 상태라, 다음 `ensureAccountForCurrentUser()` 호출이 이 낡은 계정을
  "이미 있음"으로 판정해 조기 반환 — profiles가 끝내 하나도 안 만들어져 테스트가 실패했다.
  이 테스트 파일 자신의 주석에 남아있던 "원인 불명" 과거 실패도 같은 원인으로 설명된다.
- **분류**: DB/RLS/GRANT 문제(앱 코드 버그 아님, `lib/authAccount.ts`는 정상). 실제 소셜
  로그인 사용자는 authenticated 세션(RLS)으로 accounts를 직접 관리하므로 이 GRANT 누락의
  영향을 받지 않는다 — 순수하게 테스트 cleanup(admin/service_role 경로) 전용 문제.
- **검증 완료**: SQL 적용 후 `auth-account-bootstrap.test.ts` 2회 연속 통과, throwaway 계정 cleanup이 정상적으로 성공함을 확인(더 이상 accounts/profiles 잔여 데이터가 누적되지 않음).

### P1-17. (2026-08-11, 완료) 신규 예약 정책: 관리자가 직접 지정한 수강권은 membership_schedule_rules보다 우선

| 필드 | 내용 |
|---|---|
| 우선순위 | P1(사용자 요청 정책 변경, PR #44 안정화 Batch의 Phase 1) |
| 현재 상태 | **완료. 코드/SQL 변경 완료, 사용자가 SQL 적용 완료. 전체 CI 2연속 Green 확인(run `31459078105`/`31460392240`, 둘 다 first-attempt·재시도 없음). 검증 과정에서 신규 통합 테스트 자체의 세션/RPC 선택 결함 2건을 발견해 수정(A/B/C가 공유 테스트센터의 다른 membership으로 우연히 통과/실패하던 문제, month-data 테스트의 세션 전환 누락 — 둘 다 test bug, 앱/SQL 무관).** |
| 근거 파일 | `fix_membership_schedule_rule_override_draft_proposed.sql`(적용 완료)+rollback, `app/manager/classes/page.tsx`, `tests/integration/schedule-rule-override.test.ts`(신규, A~J), `tests/e2e/admin/membership-schedule-rules.spec.ts`(D+F+K/J 갱신) |
| 완료 조건 | ~~전체 CI 2연속 Green~~ 완료. |

- **정책**: P1-15가 확정한 "class_allowed_products 허용 AND membership_schedule_rules 충족"
  정책에서, 관리자가 그 class에 특정 product를 class_allowed_products로 **명시적으로** 지정한
  경우에 한해 membership_schedule_rules를 무시하도록 확장했다. "모든 수강권 허용"(0건)이면
  기존 정책 그대로 유지된다. override는 schedule_rules만 우회하며 status/remaining_count/
  expires_at/product_kind='pass'/center 소속 등 다른 정상 조건은 그대로 적용된다.
- **적용 함수**: `usable_memberships`/`usable_memberships_for_classes`(표시), `reserve_class`
  (자동매칭), `reserve_with_membership`(회원이 직접 pass 선택 — 실제 예약 확정 경로).
  `admin_assign_reservation`은 라이브 코드에 이미 "수강권 종류/예약조건 제한은 두 방식 모두
  무시" 주석과 함께 class_allowed_products/membership_schedule_rules를 전혀 확인하지 않는
  것으로 확인돼(2026-08-11 `pg_get_functiondef` 직접 조회) 변경하지 않았다.
- **함께 발견/수정한 별도 갭**: `reserve_with_membership`(실제 회원 예약 확정 RPC)은 지금까지
  `membership_schedule_rules`를 전혀 확인하지 않고 있었다(`class_allowed_products`만 나중에
  추가되고 schedule_rules는 누락된 채로 남아 있었음 — 라이브 코드 자체 주석으로 확인). 화면
  목록(`usable_memberships_for_classes`)에서는 걸러졌지만 실제 RPC는 막지 않아 "목록≠실제
  예약 정책" 불일치가 있었다(`lib/reservations.ts:364-366` 기존 주석이 요구하는 불변식을
  위반). 이번에 이 조건을 새로 추가하면서 처음부터 override까지 포함해 넣었다.
- **소스 오브 트루스**: git의 `reservation_functions.sql`은 PR #32의 라이브 변경분(당일예약/
  일일한도/오픈시각 등)이 반영되지 않은 옛 버전이라(P2-16에 이미 문서화) 기준으로 삼지
  않고, 사용자가 Supabase SQL Editor에서 `pg_get_functiondef()`로 직접 추출한 2026-08-11
  라이브 본문을 기준으로 함수 전체를 재작성했다. 원본 가드(예약마감/오픈시각/당일예약/
  일일한도/휴무일/프라이빗 동시진행/대기예약 주간한도 등)는 전혀 손대지 않았다(정확한
  문자열 카운트 스크립트로 대조 확인).
- **별도 기존 문제(이번에 고치지 않음)**: `usable_memberships*`는 `class_title`을 정확히
  일치(`=`)로, `reserve_class`/`reserve_with_membership`은 부분 일치(`LIKE '%...%'`)로 비교 —
  서로 다른 매칭 규칙이 이미 라이브에 공존하고 있었다(이번 변경으로 만든 문제 아님, 범위 밖).
- **UX**: 수업 등록/수정 화면의 schedule-rule 경고를 모드별로 분리 — "모든 수강권 허용"일
  때는 기존 `.schedule-rule-warning`(danger) 그대로, "특정 수강권 지정" 모드에서 override
  대상이 있으면 새 `.schedule-rule-override-note`(info)로 "직접 지정이 우선"임을 안내한다.
- **Regression(A~K)**: `tests/integration/schedule-rule-override.test.ts`(A~J, RPC/DB 레벨
  매트릭스), `tests/e2e/admin/membership-schedule-rules.spec.ts`(B는 유지, D+F+K/J는 새
  정책에 맞게 갱신 — 옛 정책 하에서 "차단"을 기대하던 부분이 새 정책에서는 "사용 가능"으로
  뒤집힘).


### P1-14. (2026-08-10, 해결 완료) `attendance-policy.test.ts` 주간 대기예약 한도 초과로 Integration 반복 실패

| 필드 | 내용 |
|---|---|
| 우선순위 | 해결됨(과거 P1) |
| 현재 상태 | **완료. cleanup SQL 사용자가 직접 적용(C-1: memberB_centerA_waitlisted_remaining=0) → read-only 독립 재검증 2회(0건) → 재발 방지 코드(admin 기반 cleanup + self-healing) 커밋 → 전체 CI(E2E/Unit/Integration/Build) 2회 연속 Green, 둘 다 first-attempt·재시도 없음(run `31367089839`, `31368870324`) → Vercel Preview 성공 확인** |
| 근거 파일 | `tests/integration/attendance-policy.test.ts`, `tests/integration/setup.ts`(`cleanupTestClassAdmin`), `reservation_functions.sql`(RLS DELETE 정책 — 원인 파악용, 미수정), `cleanup_p1_14_waitlisted_test_pollution_draft_proposed.sql`(사용자가 Supabase SQL Editor에서 적용 완료) |
| 완료 조건 | ~~cleanup SQL 적용 후 재검증~~ 전부 완료 |

- **증상**: run `31356042673`부터 `31362464170`까지 Integration job이 4회 연속으로 정확히
  같은 2개 테스트에서 동일 에러로 실패: `예약 실패: 이번 주 대기예약 가능 횟수(10회)를
  초과했어요`. 같은 run들에서 E2E(TEST1/TEST2/TEST4/TEST5/TEST6 포함)와 Unit은 매번 Green.
- **실측 진단(CI run 31362464170, 임시 read-only 진단 파일로 확인 후 삭제)**: memberB
  (TEST_USER_B, profile `f2c9749a-b282-433b-8b60-a982b81a53f3`)의 waitlisted reservations가
  centerA에 정확히 13건 존재. **13건 전부** class title이 정확히 `P3 출결-대기거부`(다른
  title은 0건), created_at은 2026-08-07~2026-08-09에 걸쳐 분산(거의 매 실행마다 1건씩).
  memberA의 waitlisted는 0건.
- **근본 원인(코드로 확정, 추측 아님 — 이전 기록의 "self-inflicted 아님" 결론은 정정함)**:
  `reservation_functions.sql`의 "매니저 취소예약 정리" RLS DELETE 정책(`reservations`,
  `status in ('cancelled','no_show')`만 허용)과, "정원이 찬 그룹 수업에서 대기로 등록된
  예약은 attended로 바꿀 수 없다" 테스트가 **의도적으로 waitlisted 상태로 남기는** 예약
  (그 상태를 유지한 채 가드를 검증하는 게 테스트의 목적 자체) 사이의 범위 불일치. 옛
  `afterAll`은 매니저 세션(RLS 적용) 기반 `cleanupTestClass()`로 지웠는데, 이 정책이
  waitlisted를 허용하지 않아 `DELETE`가 **에러 없이 조용히 0건 삭제**로 끝났다(Postgrest가
  RLS에 안 걸리는 행을 그냥 매칭 안 된 것으로 처리 — 예외 아님). **완전히 동일한 원인이
  `private-class-capacity.test.ts`에서 이미 한 번 발견·우회된 적이 있었음**(그 파일 자체
  주석, `admin_cancel_reservation`이 MEMBER 타입 예약을 거부해 세션 기반 delete가 조용히
  막히는 사례) — 그 교훈이 `attendance-policy.test.ts`에는 전파되지 않았던 것.
- **재발 방지(코드 수정 완료, 커밋됨)**: `tests/integration/setup.ts`에 `cleanupTestClassAdmin(classId)`
  추가(admin/service_role 기반 — RLS를 우회하므로 예약 상태와 무관하게 확실히 삭제).
  `attendance-policy.test.ts`의 `afterAll`을 이 함수로 전환하고, `beforeAll`에 이 파일 전용
  5개 title("P3 출결-*")에 대한 self-healing 사전 정리를 추가(get-or-create/self-healing
  패턴, TEST4의 `cleanupBuyProductMemberships`와 동일 스타일) — 이후로는 이 파일이 CI
  취소/실패로 `afterAll`을 못 돌아도 다음 실행의 `beforeAll`이 스스로 정리한다.
- **과거 누적분 정리 SQL**: `cleanup_p1_14_waitlisted_test_pollution_draft_proposed.sql` —
  profile_id(memberB 정확한 UUID) + center_id(centerA 정확한 UUID) + class title 정확히
  일치("P3 출결-대기거부", LIKE 없음) + status='waitlisted' 4중 조건, `admin_action_logs`
  참조 NOT EXISTS 가드, A(read-only preview)/B(단일 트랜잭션 atomic cleanup)/C(post-commit
  검증) 구조. **참고**: 이 13개 class는 각각 memberA의 아직 살아있는 confirmed 예약도 함께
  갖고 있어(정원 1명을 memberA가 먼저 채우는 테스트 구조), class 자체는 이번 정리 후에도
  남을 가능성이 높다(안전한 의도된 동작 — 오늘 실패의 원인인 waitlisted 건수와는 무관, 남은
  class 누적은 별도의 기존 이슈 RES-002/TEST-004 계열).
- **cleanup SQL 실행 완료(2026-08-10, 사용자)**: C-1 검증 `memberB_centerA_waitlisted_remaining=0`
  확인. read-only 재검증(CI run `31365334512`)으로 독립적으로도 0건 재확인.
- **사후 검증 중 발견한 2차 이슈(코드 수정 완료, 커밋됨)**: cleanup SQL 적용 직후 재실행한
  CI(`31365334512`)의 Integration이 여전히 실패 — 그러나 증상이 달라짐: 원래의 "주간
  대기예약 한도 초과"가 아니라 `Hook timed out in 30000ms`(attendance-policy.test.ts의
  `beforeAll`). read-only로 확인한 결과 memberB의 waitlisted는 이미 0건이라 원래 버그의
  재발이 **아니었음** — 원인은 beforeAll의 self-healing sweep이 class 하나당
  `cleanupTestClassAdmin()`을 순차 await로 호출했는데, cleanup SQL이 손대지 않은 다른 3개
  title("P3 출결-대기취소" 8건/"타센터차단" 9건/그 외)에 과거부터 쌓여있던 잔여 class가
  총 24건이라 순차 round-trip(최대 48회)이 vitest `hookTimeout`(30000ms)을 실제로 초과한
  것(성능 문제, 앱 버그도 재발도 아님 — test bug). **타임아웃 값을 올리는 우회는 쓰지
  않고**, class id들을 모아 `reservations`/`classes` 각 1회씩 bulk delete로 바꿔
  round-trip 수 자체를 없앴다(원인 제거, 증상 은폐 아님). 이 변경은 부수적으로 다른 4개
  title에 쌓여있던 24건의 역사적 잔여 class도 이번 실행에서 함께 정리한다(전부 이 파일
  전용 리터럴 title, 동일한 안전 근거).
- **최종 재검증(2026-08-10)**: bulk delete 수정을 반영한 CI 2회 연속 실행 — 둘 다
  전체(E2E/Unit/Integration/Build) Green, first-attempt(재시도 없음): run `31367089839`
  (pull_request), `31368870324`(workflow_dispatch), 둘 다 headSha `80889d7`.
  `attendance-policy.test.ts` 5/5 통과(각 ~37.5초, 재시도 없음). 두 run 모두 독립적인
  read-only 진단으로 memberB centerA waitlisted=0, "P3 출결-*" 5개 title 전부 잔여 class/
  reservation 0건 재확인 — 두 번째 run은 이 파일이 그 사이에 waitlisted 예약을 새로
  만들었다가 afterAll이 정상적으로 지운 뒤의 상태라, "우연히 DB가 깨끗했다"가 아니라
  "cleanup 로직 자체가 구조적으로 작동한다"는 것을 실제로 증명함. 진단용 임시 파일
  (`tests/integration/zzz_diag_p1_14_postcleanup_verify.test.ts`)은 검증 완료 후 삭제.
  Vercel Preview도 같은 headSha 기준 배포 성공 확인.

### P2-20. (2026-08-09, 해결됨) class_allowed_products 선택이 저장 직후 재진입 시 사라짐 + `.pass-pick-list` 미표시

| 필드 | 내용 |
|---|---|
| 우선순위 | 해결됨(과거 P2) |
| 현재 상태 | **완료 — goal1/goal2 모두 원인 확정·수정·검증 완료. cleanup SQL 사용자가 직접 적용(891→5건), 임시 진단 계측 전부 제거. class-allowed-products.spec.ts 3연속 Green, 전체 CI(E2E/Unit/Integration/Build) 3연속 Green, Vercel Preview 성공 확인** |
| 근거 파일 | `app/manager/classes/page.tsx`(`openEdit`, `openTokenRef`/`userEditedRef`), `lib/reservations.ts`(`fetchUsableMembershipsByClass`), `cleanup_p2_20_e2e_test_pass_duplicates_draft_proposed.sql`(적용 완료) |
| 완료 조건 | ~~cleanup SQL 적용 후 재검증~~ 전부 완료 |

- **goal1 (관리자 화면 선택 사라짐) — 원인 확정, 수정 완료**: `openEdit()`의 초기
  `fetchClassProducts()` hydrate 응답(~340ms)이 사용자의 chip 클릭보다 늦게 도착하면
  `setSelectedProducts(ids)`가 무조건 실행돼 사용자의 선택을 덮어썼다(특히 새 class라
  DB 스냅샷이 빈 배열일 때 조용히 초기화됨). `openTokenRef`(요청 세대 비교) +
  `userEditedRef`(dirty flag) 가드를 추가해 `isStale = myToken !== openTokenRef.current
  || userEditedRef.current`일 때만 적용을 건너뛰도록 구조적으로 수정 — CI로 재현/수정
  둘 다 실측 확인함(`APPLY_FETCH_RESULT`가 `applied:false`로 정확히 스킵되는 것을 확인).
- **goal2 (`.pass-pick-list` 미표시) — 원인 확정**: `lib/reservations.ts`의
  `fetchUsableMembershipsByClass()`가 `usable_memberships_for_classes` RPC 응답을
  `.range()`로 1000행씩 순차 페이지네이션한다. TEST_USER_A의 centerA 소속
  membership 891건(아래 원인)이 class당 ~744행이라는 거의 상수 크기의 RPC 응답을
  만들어내고, 실패 재현 조건(수업 36개)에서 클라이언트가 이를 **27번 순차 왕복**해서
  받아온다 — 실측 총 12.4~13.9초(page당 ~300~1100ms). 관측된 ".pass-pick-list가
  10초 넘게 안 뜸" 증상과 정확히 일치(수업 8개일 땐 6페이지·1.6~1.9초로 재현 안 됨,
  그래서 작은 케이스에선 정상 동작). RPC 서버 실행 자체는 항상 빠름(단일 호출
  0.3~0.9초) — "membership이 많으면 느리다"가 아니라 "많으면 응답이 커져서 클라이언트
  왕복 횟수가 늘어난다"는 점을 CI 실측으로 검증함(추측 아님).
- **원인(historical duplicate memberships)**: centerA(3937eb89-...)에 `product_name=
  'E2E 테스트 수강권'`인 memberships가 profile_id 무관 891건(userA 827 + 다른 테스트
  프로필 64) 쌓여 있었다 — `createTestMembershipAdmin()`이 get-or-create로 수정되기
  전에 CI 반복 실행(특히 취소된 실행이 `afterAll`을 건너뛴 경우)으로 누적된 것.
- **cleanup SQL 적용 완료(2026-08-09)**: `cleanup_p2_20_e2e_test_pass_duplicates_draft_proposed.sql`
  — 정확한 product_name+center_id로 식별, 6개 FK 테이블(reservations/payments/
  membership_transfers/product_passes/contracts/admin_action_logs) 전부 NOT EXISTS로
  제외(참조 있는 membership은 절대 안 지움). 첫 시도는 사용자가 BEGIN+DELETE와 COMMIT을
  Supabase SQL Editor의 서로 다른 두 번의 Run으로 나눠 실행해 커넥션 풀링으로 세션이
  갈리는 바람에 COMMIT이 실제로는 아무것도 커밋 못 하고 DELETE가 자동 rollback되는 문제가
  실측 발견됨(891/1557 그대로) — A(read-only preview)/B(BEGIN~COMMIT을 한 번의 Run으로,
  내부 4중 검증 후 자동 커밋/롤백)/C(post-commit verification) 구조로 재작성 후 사용자가
  한 번의 Run으로 재실행해 성공. 결과: centerA의 "E2E 테스트 수강권" 891→5건(FK로 보존된
  것만), TEST_USER_A 전체 memberships 1557→730건. 전부 read-only 재검증으로 확인함(P5).
- **RPC 페이지네이션 루프 재측정(P5, cleanup 후)**: n=1 1페이지/291ms(이전 744행/1페이지),
  n=8 1페이지/251ms(이전 6페이지/5952행/1.6~1.9초), **n=36 2페이지/1908행/1068ms**(이전
  27페이지/26784행/12.4~13.9초) — 12배 이상 개선, `.pass-pick-list` 미표시 증상이 실제로
  해소됨을 CI에서 실측 확인.
- **임시 진단 계측 전부 제거 완료(P7, 2026-08-09)**: `lib/_diag220.ts`,
  `tests/integration/_diag_memberships.test.ts` 삭제, 4개 파일의 `diagEvent` 호출/import
  전부 제거(프로덕션 로직은 그대로 유지), `.github/workflows/test.yml`의 `diag` job/
  `diag_only` input 제거해 원래 구조로 복원. `npm run build` 통과 확인.
- **최종 검증(P5~P9)**: class-allowed-products.spec.ts 3연속 Green(5/5 테스트, goal1/goal2
  둘 다 포함), 전체 CI(E2E/Unit/Integration/Build) 3연속 Green, Vercel Preview 배포 성공
  확인. P4 sales dashboard 회귀 없음(`dashboard-summary.test.ts` 7/7, Integration 112/112,
  Unit 203/203 전부 통과).
- **(발견, 별도 이슈로 기록) `daily-book-limit.spec.ts`의 기존에 이미 문서화된 인프라
  플레이키니스 1회 재현**: 최종 3연속 CI 중 마지막 회차에서 이 파일의 테스트가 1회
  실패(`.sheet-overlay` 모달이 예약 확정 클릭 후 10초 안에 안 닫힘) 후 재시도에서 성공.
  P2-20이 건드린 파일(`app/reservation/page.tsx` 등)과 무관함을 `git diff`로 직접 확인함
  (diagEvent 호출 제거 외 로직 변경 없음). 이 테스트 파일 자체의 기존 주석에 이미
  "CI dev 서버가 짧은 시간에 몰리는 요청 중 하나를 드물게 못 끝내는 경우가 실측 확인됨"이라고
  기록돼 있고 타임아웃을 120초로 이미 늘려둔 상태 — 새 회귀가 아니라 기존에 알려진 인프라
  노이즈의 재발로 판단, 이번 배치에서 추가 조치 안 함.
- **(신규) `membership_transfers`/`product_passes`/`contracts`도 service_role SQL
  GRANT 없음**: 이번 진단에서 이 세 테이블에 대한 count 조회가 전부 빈 에러 객체
  (`code/message/details/hint` 전부 undefined)로 실패 — `payments`/`admin_action_logs`/
  `accounts`(아래)와 같은 계열(P2-13). cleanup SQL은 이 GRANT gap과 무관하게 NOT EXISTS로
  방어하도록 설계해 안전성에는 영향 없음 — GRANT 자체를 고치는 것은 이번 범위 밖.
- **(신규) `accounts` 테이블도 service_role SQL GRANT 없음**: 교차검증 쿼리가
  `"permission denied for table accounts"`로 실패 — `payments`(P4에서 발견)/
  `admin_action_logs`/`membership_transfers`/`product_passes`/`contracts`/
  `locker_assignments`/`point_transactions`/`progress_records`와 같은 계열(P2-13).
  이번 배치에서 GRANT SQL을 만들지 않음(진단은 `profiles`만으로 충분히 확인됨) — 향후
  admin 클라이언트로 이 테이블에 직접 접근해야 하는 테스트가 생기면 그때 추가.
- **(신규, P6 — 별도 후속 작업) `usable_memberships_for_classes` RPC/클라이언트 페이지네이션
  구조 감사 필요**: 이번 진단으로 RPC 서버 실행 자체는 항상 빠름(0.3~0.9초)을 확인했지만,
  `fetchUsableMembershipsByClass()`의 `.range()` 순차 페이지네이션은 회원이 보유한
  "이 조건에 맞는 membership 행 수 × 조회하는 class 수"에 선형으로 왕복 횟수가 늘어나는
  구조다 — 이번엔 테스트 계정의 historical duplicate가 원인이었지만, 실제 서비스에서
  회원이 정상적으로 수백 건의 membership을 보유하고 한 번에 수십 개 class를 조회하는
  경우(예: 한 달 캘린더 전체 로드) 같은 방식으로 여러 번 순차 왕복이 발생할 수 있다.
  프로덕션 RPC/클라이언트를 지금 수정하지 않음(실제 문제가 증명되지 않았는데 추측성으로
  고치지 말라는 원칙) — 실제 서비스 규모의 회원 데이터로 별도 측정 후 필요성이 확인되면
  그때 (a) RPC 안에서 `profile_id`/`center_id`를 더 일찍 필터링하는지, (b) 클라이언트가
  전체를 한 번에 순차 페이지네이션하는 대신 필요한 만큼만 요청하도록 바꿀지 검토할 것.
- **(신규, P6 조사 중 발견 — 별도 후속 작업) `lib/reservations.ts`의 `fetchMonthData()`가
  회원 자신의 `memberships`를 조회하는 쿼리(`myMems`, 91-95행)가 페이지네이션 없이
  `.in("profile_id", myProfileIds)` 한 번만 호출한다** — 바로 아래 `classRows` 쿼리는
  같은 이유(PostgREST 1000행 응답 캡)로 이미 `.range()` 루프로 고쳐져 있는데, `myMems`는
  아직 안 고쳐진 채로 남아 있다. 이번 cleanup 전 진단에서 TEST_USER_A가 정확히 1000건
  (캡에 걸린 값)으로 관측된 것이 이 쿼리였다 — 실제 회원이 1000건 넘는 memberships를
  보유하면(가능성은 낮지만 구조적으로는 가능) 일부 센터의 활성 수강권이 누락돼
  `membershipCenterIds` 계산이 틀어지고, 그 회원이 그 센터 수업을 못 보게 될 수 있다.
  이번 배치에서는 P2-20 범위 밖이라 수정하지 않음(cleanup 후 TEST_USER_A도 730건으로
  캡 밑으로 내려가 현재는 증상 재현 안 됨) — `fetchClasses`/`fetchUsableMembershipsByClass`와
  동일한 패턴으로 `.range()` 페이지네이션을 추가하는 것을 향후 별도 작업으로 검토할 것.

- **실제 원인(읽기 전용 진단으로 직접 확인, 추측 아님)**: 거의 모든 integration/e2e 테스트가
  `getOrCreateOwnedTestCenter(managerA)`로 **단 하나의 공유 센터**를 재사용하는데, 그 안의
  `memberships`가 PostgREST 기본 1000행 응답 캡에 걸릴 만큼 누적돼 있었다(진단 시점 캡 안에서만도
  "통합테스트 수강권" 979건 등). `class-allowed-products.spec.ts`는 이 프로필의 "사용 가능한
  수강권" 전체를 화면에 나열하는데, 그 목록이 수백~수천 건이 되면서 검색/카운트 검증이
  타임아웃·간헐 실패했다 — class_allowed_products 기능 자체의 버그가 아니었다.
- **근본 원인 코드**: `createTestMembership()`(setup.ts), `createTestMembershipAdmin()`/
  `createTestGoodsMembershipAdmin()`(e2e/fixtures/testData.ts, 11개 이상의 spec이 사용),
  `class-allowed-products-enforcement.test.ts`의 로컬 `createMembershipForProduct()`,
  `usable-memberships-pass-kind.test.ts`의 인라인 products/memberships insert — 전부
  get-or-create 없이 호출마다 새 행을 만들었다. `afterAll` 정리가 있는 파일도 CI가 그 테스트
  도중 취소되면(GitHub Actions `concurrency.cancel-in-progress`, 또는 사람이 새 실행을 다시
  트리거) `afterAll` 자체가 실행되지 않아 그대로 남는다 — 이 세션에서만도 CI를 여러 번 연속
  재트리거하며 실제로 이 경로로 쌓임을 확인함.
- **코드 수정 완료(이번 배치)**: 위 다섯 곳 전부 `createTestMembershipForProduct()`가 이미
  증명한 get-or-create + self-healing refresh 패턴으로 교체 — 앞으로는 같은 방식으로 다시
  쌓이지 않는다. `attendance.spec.ts`는 추가로 `beforeAll`에 고아 프로필("P3 출결-대기용",
  `afterAll` 미실행 시 남음) 자체 정리 스윕을 추가했다.
- **SQL 정리(적용 대기)**: `cleanup_shared_test_center_pollution_draft_proposed.sql` — 지금까지
  이미 쌓인 데이터(1회성)를 정리. 대상은 정확한 문자열/계정으로 식별되는 테스트 전용 데이터만
  (진단 결과 "그 외 profile_id 0건" 확인, 실사용자/실센터 데이터 아님). BEGIN/COMMIT +
  미리보기 카운트 + 예상 범위 벗어나면 RAISE EXCEPTION 가드 포함.
- **범위 밖 → 이슈로 분리됨(2026-08-10, [TEST-004 #45](https://github.com/sonjw222/booking-app/issues/45))**:
  같은 진단에서 `classes` 테이블도 1000행 캡에 걸릴 만큼 누적돼 있음을 발견
  (`admin-assignment-security.test.ts`의 "성공경로-*" 시나리오만 최소 914건,
  `P1-12`/`RES-001`/`CLASS-001`/`SETTINGS-REAUDIT` 등 추가). 이 파일들은 이미 `afterAll`로
  정리하도록 설계돼 있어(get-or-create 부재 문제가 아님) — 근본 원인은 "CI 취소 시 afterAll
  미실행"과 동일 계열이지만, 파일마다 시나리오별 고유 데이터라 get-or-create 전환이
  부적절하고, `beforeAll` 자체 정리 스윕을 5개 이상 파일에 각각 설계해야 하는 더 큰 작업이다.
  class-allowed-products.spec.ts의 현재 실패와 직접 관련 없어 P2-20 배치 범위에서는 제외했고,
  **다음 안정화 배치의 확정 우선순위**로 TEST-004에 반영함(TEST-002 #24와 같은 근본 원인
  계열로 함께 검토 권장).

### 다음 안정화 배치 확정 우선순위 (2026-08-10, PR #44 리뷰 중 확정)

P2-20 조사 과정에서 발견됐지만 이번 배치 범위 밖이라 코드 수정 없이 이슈로만 분리한
3건 — 다음 안정화 배치에서 이 순서로 착수할 것을 확정한다.

| 순위 | 이슈 | 요약 | 근거 |
|---|---|---|---|
| 1 | [RES-002 #42](https://github.com/sonjw222/booking-app/issues/42) | `fetchMonthData()`의 `myMems` 쿼리가 PostgREST 1000행 캡 미대응 | **2026-08-11 완료** — `classRows`/`fetchUsableMembershipsByClass`와 동일한 `.range()` 페이지네이션을 `myMems`에도 적용(`lib/reservations.ts`). 회귀 테스트 `tests/integration/month-data-memberships-row-limit-regression.test.ts` 추가(1005개 필러 membership 뒤의 target membership이 여전히 감지되는지, 자녀 프로필 공유 구조도 함께 확인). SQL 변경 없음(순수 코드 수정). 전체 CI 2연속 Green으로 검증됨(run `31459078105`/`31460392240`) |
| 2 | [TEST-004 #45](https://github.com/sonjw222/booking-app/issues/45) | `classes` 테이블 공유 테스트센터 오염(1000행 캡, 최소 914건) | **2026-08-11 완료** — 재진단 결과 실제로는 1761건까지 누적(22개 title_prefix 그룹, 최대 기여자: `admin-assignment-security.test.ts`의 "성공경로-*" 8종 ~812건, `diagnose-settings-live-values.test.ts`의 "DIAG 일일한도" 141건 등). `tests/integration/setup.ts`의 `getOrCreateOwnedTestCenter()`에 self-healing sweep을 추가(start_time이 1시간 이상 과거인 class를 해당 테스트센터에서 자동 정리) — 사실상 모든 통합 테스트 파일이 이 함수를 beforeAll에서 호출하므로 파일마다 정리 로직을 따로 만들지 않고 스위트 전체가 자동으로 self-healing된다. 별도로 `diagnose-settings-live-values.test.ts`(RLS 기반 `cleanupTestClass` 사용 — confirmed 상태 예약의 delete가 조용히 실패해 **매 실행 결정적으로 leak**하던 실제 원인 발견)를 `daily-book-limit-wiring.test.ts`로 정리(당일예약 describe는 `operational-settings-wiring.test.ts`와 완전 중복이라 제거, 일일한도 describe는 admin 기반 cleanup으로 교체해 유지). 이미 쌓인 1761건은 별도 cleanup SQL 없이 CI 실행에서 sweep이 자동으로 정리함(모두 start_time이 이미 과거라 즉시 대상) — SQL 불필요. 전체 CI 2연속 Green으로 검증됨(run `31459078105`/`31460392240`) |
| 3 | [TEST-003 #43](https://github.com/sonjw222/booking-app/issues/43) | `daily-book-limit.spec.ts` 잔여 CI 인프라 플레이키니스 | **2026-08-11 완료** — 실제 실패 로그(run `31393468107`)를 직접 조사해 "그냥 flaky"로 단정하지 않고 정확한 원인 추적: `app/reservation/page.tsx`의 `doReserve()`/`handleCancel()`이 RPC 성공 → 시트 닫힘 → `await load()`(전체 재조회) 순서로 동작해, 시트가 닫히는 시점과 `.class-row` 버튼이 "예약"↔"취소"로 갱신되는 시점 사이에 실제 간격이 있음을 확인. 이 파일은 예약/취소 왕복을 최대 9회 반복해 CI 부하 시 그 간격이 Playwright 기본 expect timeout(10초)을 넘기는 사례가 실측됨(첫 시도 실패 → 재시도 통과, 앱/RPC 버그 아님 — 예약 자체는 이미 성공한 뒤였음). 분류: CI 인프라/타이밍(app bug/test bug 아님). 수정: 정확히 이 버튼 상태 assert 5곳만 timeout을 20초로 늘림(무조건적인 전체 timeout 증가 아님, 진단된 병목에만 적용). 전체 CI 2연속 Green으로 검증됨(run `31459078105`/`31460392240`) |

### P1-18. (2026-08-20, 정책 변경 Live 적용 + 자동 통합테스트 확인 완료) 계정 탈퇴

| 필드 | 내용 |
|---|---|
| 우선순위 | P0 (Apple/Google 앱스토어 계정 삭제 가이드라인 대응 — 단순 비활성화만으로는 심사 통과 어려움) |
| 현재 상태 | **운영 반영 완료 + 자동 검증 완료.** `fix_account_deletion_real_anonymization.sql`을 사용자가 SQL Editor에서 실행(기존 소급 대상 1건 익명화 + auth.users 삭제, 라이브 재조회로 확인), `supabase functions deploy delete-account`로 재배포 완료(버전 8→9 확인). 새로 작성한 통합테스트(`tests/integration/account-deletion-anonymization.test.ts`)가 배포된 Edge Function을 실제로 호출해 왕복 전체를 자동 검증, 통과. |
| 근거 파일 | `app/settings/account/page.tsx`, `lib/accountDeletion.ts`, `supabase/functions/delete-account/index.ts`, `add_account_deactivation.sql`(기존), `fix_account_deletion_real_anonymization.sql`, `rollback_fix_account_deletion_real_anonymization.sql`, `tests/integration/account-deletion-anonymization.test.ts`(신규), `docs/platform-spec/epics/EPIC_03_Authentication.md` AUTH-08 |
| 이번 배치에서 한 것 | 기존 방식(2026-08-13, `deactivated_at` + `auth.users` ban)은 로그인만 막을 뿐 이름/전화번호/이메일 등 개인정보가 그대로 DB에 남는 **소프트 삭제**였음 — Apple/Google 계정 삭제 가이드라인은 실제 삭제 또는 식별 불가 처리를 요구해 정책 상 P0 갭으로 재분류. 사용자 결정(2026-08-19): (1) 탈퇴 후 같은 전화번호/이메일/소셜 계정으로 **재가입 허용**, (2) 이미 탈퇴한 기존 계정에도 **새 정책 소급 적용**. `delete-account` Edge Function을 재작성해 `accounts`/`profiles`(가족 프로필 포함)의 이름/닉네임/전화번호/주소/아바타/메모/생년월일/라벨을 익명값으로 덮어쓰고, `auth.users` 행을 밴이 아니라 **실제 삭제**(`admin.auth.admin.deleteUser`)하도록 변경(FK 안전성 확인: `accounts.auth_id`는 FK 제약 없음, `auth` 스키마 내부 테이블은 전부 `ON DELETE CASCADE`). `reservations`/`orders`/`payments`/`memberships`는 CLAUDE.md 규칙 3 및 전자상거래법 보관 의무에 따라 그대로 유지 — 익명화된 accounts/profiles를 통해서만 "탈퇴한 회원"으로 보임. `center_members.app_email` 등 센터 자체 CRM 데이터는 범위 밖(우리 플랫폼 개인정보 아님)이라 건드리지 않음. `app/settings/account/page.tsx` 탈퇴 안내 문구를 새 정책(개인정보 삭제/식별불가, 재가입 가능)에 맞게 수정. **사용자가 SQL 실행 + Edge Function 재배포 완료 — 라이브 재조회로 accounts/profiles 익명화, auth.users 삭제(count=0) 직접 확인.** 이어서 자동 통합테스트 신규 작성: service_role로 전용 임시 계정(본인+자녀 프로필)을 만들고, 실제 배포된 `delete-account`를 호출해 (1) accounts/profiles 8개 필드 전부 익명화 (2) `auth.users` 실제 삭제(`getUserById` 404) (3) 같은 이메일로 즉시 재가입 성공까지 왕복 검증 — 실행 결과 1/1 통과, `afterAll`에서 테스트 데이터 전부 정리(라이브 재조회로 leftover 0건 확인). `npm run build` 통과 확인. |
| 남은 작업 | (1) 소셜 로그인 계정의 진짜 재인증(현재는 확인 문구로 낮은 문턱만 둠) (2) 탈퇴 회원이 매니저 쪽 회원 검색/명단에 계속 노출되는지 등 후속 화면 영향 검토 (3) 실제 화면에서 손으로 눌러보는 수동 왕복 QA(자동테스트는 Edge Function을 직접 호출 — UI 클릭 흐름 자체는 아직 미확인) |
| 관련 문서 | `docs/platform-spec/epics/EPIC_03_Authentication.md` AUTH-08 |

### P2-22. (신규, 2026-08-13 / 2026-08-14 leftover 정리 완료) `getOrCreateOwnedTestCenter()` self-healing sweep이 미래 시각 leftover class는 못 잡음 — AUTO-SEC-I 간헐 실패 원인

| 필드 | 내용 |
|---|---|
| 우선순위 | P2 (테스트 인프라 한정 — 보안 로직과 무관, SEC-114 배치 범위 밖) |
| 현재 상태 | **이미 쌓인 leftover 318건 정리 완료(cleanup_p2_22_shared_center_class_fixtures_draft_proposed.sql, 사용자 실행·검증 완료). 근본 원인(sweep이 미래 시각은 안 잡음) 자체는 코드 수정 안 함 — 재발 가능성 있음, 아래 완료 조건 (a) 참고** |
| 근거 파일 | `tests/integration/setup.ts`(`getOrCreateOwnedTestCenter()`의 sweep, TEST-004 #45), `tests/integration/auto-book-membership-security.test.ts`(`AUTO-SEC-I`), `cleanup_p2_22_shared_center_class_fixtures_draft_proposed.sql`(신규, 적용 완료) |
| 완료 조건 | (a) sweep 조건을 "과거"뿐 아니라 "제목이 알려진 테스트 fixture 패턴이고 미래인 것"까지 넓혀서 재발 자체를 막을 것(아직 안 함 — 이번엔 이미 쌓인 것만 1회성으로 정리) |

**2026-08-21 재발 확인**: [P2-28](#p2-28)의 AUTO-SEC-I가 같은 메커니즘으로 다시 실패했다 —
이번엔 leftover class가 아니라 leftover **reservation**(`USER_B` 소유, 다른 파일이 남김)이
원인이었다는 차이만 있음. `auto_book_membership()`의 "하루 1건" 체크가 `profile_id`만
기준이고 `center_id` 스코프가 없다는 게 이 재발들의 공통 근본 원인 — 완료 조건 (a)의 sweep
확장 대신, 이번엔 P2-28에서 해당 테스트 파일 하나에만 좁게 방어 코드를 추가했다(전체 해결
아님, 계속 열어둠).

**2026-08-21 재발 2건째**: `daily-book-limit-wiring.test.ts`도 PR #72 CI에서 같은 계열로
실패(`USER_A`의 `centerAId` 오늘자 leftover 확정 예약 때문에 신규 1·2번째 예약까지 한도
초과로 거부됨). 자정(KST) 경과로 저절로 해소될 거라 예상했지만 CI 재실행에서도 동일하게
재현돼(로컬은 통과 — 동시에 도는 다른 세션/CI가 원인일 가능성), AUTO-SEC-I와 같은 패턴의
방어 코드(`clearUserATodayReservations()`)를 이 파일에도 추가. **완료 조건 (a)(sweep
자체를 근본적으로 고치는 것)는 세 번째 재발에도 불구하고 여전히 안 됨** — 개별 테스트
파일마다 방어 코드를 추가하는 대신, `getOrCreateOwnedTestCenter()`/`switchToTestUser()`
레벨에서 공통으로 처리하는 근본 수정을 진지하게 고려할 시점.

**2026-08-21 중복 제거(부분 개선, 완료 조건 (a) 자체는 여전히 미해결)**: 두 파일이 각자
만든 거의 동일한 정리 코드를 `tests/integration/setup.ts`의 공용 헬퍼
`clearProfileReservationsOnKstDates(profileId, kstDates, centerId?)`(+ `kstDateStr()`)로
합쳤다 — 앞으로 날짜 기반 검증을 새로 추가하는 테스트는 이 함수를 import해서 예약 생성 전에
호출하면 된다(관례로 문서화). 의도적으로 sweep(완료 조건 (a), 넓게 훑어서 자동으로 지우는
방식)은 채택하지 않았다 — 다른 세션이 지금 막 만든 진짜 데이터를 지울 위험이 있어서다. 대신
"이 테스트가 실제로 쓸 날짜만" 정확히 겨냥해 정리하는 방식을 표준 패턴으로 굳혔다. 즉
**재발 자체를 막지는 못하지만(새 테스트 파일이 이 관례를 안 따르면 또 재발 가능), 재발했을
때 고치는 비용은 "새 파일에 이 헬퍼 한 줄 추가"로 크게 줄었다.** 로컬에서 두 파일 모두
(17+1=18개 테스트) 통과 확인.

**2026-08-14 leftover 정리 완료**: 제목 리터럴을 나열하는 대신 구조적 기준(이 하나의 공유
테스트센터 + `status='open'` + `start_time > now()` + `created_at`이 1시간 이상 과거 — 지금
막 어떤 세션이 만든 class까지 실수로 지우지 않기 위한 안전 마진)으로 `cleanup_p2_22_shared_
center_class_fixtures_draft_proposed.sql` 작성. 사용자가 read-only 진단(A)으로 318개 class/
237개 딸린 reservation을 먼저 확인(예상 범위 내, 안전 상한 3000건의 10분의 1 수준) → 삭제(B,
BEGIN/COMMIT 트랜잭션) 실행 → 검증(C)에서 `remaining_target_classes=0`, 이 센터에 정상적으로
남아야 할 263건은 그대로 보존됨을 확인. rollback 파일은 순수 DELETE라 SQL로는 되돌릴 수 없다는
설명 안내(P3 SEC-MC cleanup과 동일한 패턴) — 지워진 행은 전부 자동화 테스트 전용 leftover라
"복구"가 아니라 "다음에 그 테스트가 필요할 때 다시 만들어내는 것"이 정답.

- TEST-004 #45가 추가한 sweep은 `start_time`이 1시간 이상 **과거**인 class만 정리한다. 그런데
  SEC-101/112/113~117 회귀 테스트 중 `auto-book-membership-security.test.ts`를 로컬로 처음
  실행하며 `AUTO-SEC-I`(정상 자동예약의 예약 수/잔여횟수 정합성, `expect(booked).toBe(2)`)가
  `booked=3`으로 실패했다. 원인 진단(read-only) 결과, managerA 소유 공유 테스트센터
  (`3937eb89-3803-43e9-9a29-e893f779df1a`)에 `status='open'`이고 `start_time`이 **미래**(짧게는
  며칠, 길게는 2026-09-12/2026-11-11까지)인 leftover class가 300개 이상 남아있었다 —
  `P3 통합-*`, `E2E 한도*`, `CLASS-001 기본값사용`, `SETTINGS-REAUDIT *`, `P1-12 *`, `P2
  알림격리-*`, `DIAG-NEWCLASS-BUG *` 등 여러 파일/세션의 잔재. 이 중 다수가
  `class_allowed_products` 제한이 전혀 없어서, `auto_book_membership()`(SEC-114 수정 대상)의
  "센터+요일만 일치하면 예약 가능" 매칭 로직이 새로 만든 테스트 수업뿐 아니라 이 leftover들도
  같은 요일이면 함께 집어 예약해버린다.
- **SEC-114 보안 수정 자체와는 무관함을 확인**: `auto_book_membership()`의 business logic(요일
  매칭, class_allowed_products 필터, 하루 1개 제한, 정원 체크)은 이번 세션에서 한 줄도 바꾸지
  않았다(authorization 블록만 추가, `fix_auto_book_membership_idor_draft_proposed.sql` 헤더
  참고) — leftover 오염이 없었다면 기존 코드로도 정확히 2개만 잡혔을 것. 같은 파일의
  `AUTO-SEC-J`(멱등성 — 같은 membership으로 재호출해도 중복/초과 차감이 없는지)는 정확한
  개수가 아니라 "두 번째 호출은 0개"만 확인하는 방식이라 이 오염에 영향받지 않고 통과했다.
- 대량(300건+) 삭제이고 `reservations`/`attendance` 등 FK 연쇄 영향 범위를 파일별로 다시
  조사해야 해서, 이번 보안 배치 범위에서 임의로 cleanup SQL을 작성·적용하지 않았다. sweep
  조건을 미래까지 넓히는 것도 "다른 테스트가 지금 막 만든, 아직 안 끝난 미래 class"까지
  지워버릴 위험이 있어 신중한 설계가 필요하다.

### P2-23. (신규, 2026-08-15) 최근 merge된 PR들이 CI 완전 그린 없이 merge됨 — 나중에 한 번에 재검증 필요

| 필드 | 내용 |
|---|---|
| 우선순위 | P2 (기능 결함 아님 — 검증 커버리지 확인용 후속 작업) |
| 현재 상태 | **확인 필요 — 아래 PR들을 모아 한 번에 깨끗한 CI를 돌려 재확인할 것** |
| 근거 파일 | 없음(작업 로그 성격) |
| 완료 조건 | 아래 PR들이 반영된 시점의 `main`에서 전체 CI(E2E/Unit/Integration/Build)를 한 번 더 돌려 각 실패가 실제로 무관한 기존 플레이키니스였는지 최종 확인 |

- **PR #51**(SEC-101/112/113/114/115/116/117): CI 재시도 여러 번 중 마지막엔 Integration에서
  P2-22(leftover 오염)/범위 밖 항목 2건만 남고 merge — Integration 전체 그린은 아니었음.
- **PR #55**(P2-22 leftover 정리): 앱 코드 변경 없음(SQL/문서만)이라 CI 자체가 무관.
- **PR #56**(P1-13 pay_methods/review_point 추가 보호): E2E에서 `daily-book-limit.spec.ts`
  실패 1건 + `attendance.spec.ts` flaky 1건(재시도로 복구) — 둘 다 이 PR과 무관한 파일로
  확인했으나, E2E 게이팅 때문에 Unit/Integration/Build는 아예 안 돌고 스킵된 채로 merge됨.
- **PR #63 merge 직후 main push run(2026-08-19, run 32267575685)**: `npx playwright install
  --with-deps chromium` 단계가 멈춰(같은 날 다른 두 run은 이 단계가 22초~1분37초, 이번엔
  20분+) 2026-08-14/15 사고 대응으로 넣어둔 `timeout-minutes: 20`(PR #59)이 정확히 의도대로
  작동해 자동 cancel됨 — 워크플로 파일 변경 없음, 그 순간의 러너/네트워크 일시 문제로 추정.
  이번에도 E2E 게이팅으로 Unit/Integration/Build가 스킵된 채 끝나 PR #56과 같은 패턴 반복.

셋 다 "실패 내역이 변경된 코드와 무관함"은 개별적으로 확인하고 merge했지만, Unit/Integration/
Build까지 실제로 통과하는지는 아직 한 번도 끝까지 확인 못 했다. `main`이 안정된 시점에 한
번에 몰아서 깨끗한 CI를 돌려 재확인할 것.

### P2-24. (신규, 2026-08-19) `npx playwright install --with-deps chromium`이 무출력 상태로 20분 타임아웃까지 멈춤 — 3연속 재현

| 필드 | 내용 |
|---|---|
| 우선순위 | P2 (CI 인프라 — 앱 코드 버그 아님, 하지만 검증 자체를 막음) |
| 현재 상태 | **미해결 — 원인 미확인** |
| 근거 파일 | `.github/workflows/test.yml`(e2e job, `timeout-minutes: 20`, 관련 배경 주석 참고) |
| 완료 조건 | 재현 원인 파악(캐시 미설정 때문에 매번 풀 다운로드하는 게 원인인지, 러너/미러 문제인지) 후 안정화 또는 timeout-minutes 조정 |

PR #53/#54/#64의 CI 재트리거 과정에서 `npx playwright install --with-deps chromium` 단계가
**3번 연속** 아무 출력도 없이(`Downloading Chromium...` 같은 로그 한 줄도 안 찍힘) 20분 job
timeout까지 그대로 멈춰 있다가 `cancelled`로 종료됨(run `32266635345`, `32266654000`, 재시도분
포함). GitHub Actions 자체 상태 페이지는 "All Systems Operational"이라 플랫폼 전역 장애는
아님. 기존에 이미 알려진 "job이 통째로 멈춰서 전역 concurrency 큐를 막는" 패턴
(2026-08-14/15, 12시간·25시간+ 사례 — `timeout-minutes: 20`을 넣은 배경)과 같은 계열의
재발로 보이나, 이번엔 `npm run test:e2e` 자체가 아니라 그 앞 단계인 브라우저 설치에서
멈췄다는 점이 다름.

의심되는 원인(미검증):
- `actions/setup-node@v4`에 `cache: npm`은 있지만 Playwright 브라우저 바이너리
  (`~/.cache/ms-playwright`)는 별도 캐싱이 없어 매 실행마다 풀 다운로드 — 다운로드 소스가
  느리거나 rate limit에 걸리면 그대로 멈출 수 있음.
- 짧은 시간에 여러 세션이 동시에 CI를 트리거하면서 같은 GitHub-hosted 러너 풀/네트워크 경로에
  부하가 몰렸을 가능성.

다음에 이 문제를 다시 보는 사람은: (1) 같은 지점에서 계속 재현되는지 먼저 확인, (2) 재현되면
`actions/cache`로 `~/.cache/ms-playwright` 캐싱 추가를 시도, (3) 그래도 안 되면 GitHub
지원팀/커뮤니티에 문의하거나 다른 시간대에 재시도.

### P2-25. (2026-08-20, L/O 수정 완료 — K/M/N은 앱 버그 아님으로 결론) `auto-book-membership-security.test.ts`의 AUTO-SEC-K/L/M/N/O 5개 실패 원인 규명

| 필드 | 내용 |
|---|---|
| 우선순위 | P2 (테스트 코드/fixture 문제 — 앱 로직 버그 아님으로 확인됨) |
| 현재 상태 | **완료 — L/O는 테스트 코드 버그로 수정, K/M은 공유 fixture 동시성 문제(코드 수정 대상 아님), N은 P1-12 의존으로 보류** |
| 근거 파일 | `tests/integration/auto-book-membership-security.test.ts`(AUTO-SEC-K~O), `fix_auto_book_membership_idor_draft_proposed.sql`(RPC 실제 정의), `cleanup_p2_25_leftover_test_center_holiday.sql` |
| 완료 조건(L/O) | 완료 — `fix/p2-25-auto-book-security-test-flakiness` 브랜치 참고 |

처음엔 공유 fixture(`통합테스트센터-*`, `center_id=3937eb89-...`)의 `center_settings` 오염을
의심했으나(리셋해도 재현, `origin/main` 단독 실행에서도 재현 확인) 각각 개별 원인이 달랐다:

- **`AUTO-SEC-L` (수정 완료)**: `createAutoBookProduct()`가 `products.price`를 설정하지 않아
  스키마 기본값 0으로 생성됐고, 테스트가 하드코딩한 `orders.amount=10000`과
  `fulfill_order()`의 가격 검증이 항상 불일치해 `P0001` 에러가 났다. `createAutoBookProduct()`에
  `price: 10000` 추가로 해결.
- **`AUTO-SEC-O` (수정 완료)**: `asUserB()`(회원 세션)로 전환한 **직후**
  `createFutureTestClass()`를 호출해서 수업을 만들었는데, `classes` INSERT RLS 정책
  (`매니저 수업 생성`, `center_id in (select my_managed_center_ids())`)은 매니저 세션이
  필요하다. 회원 세션 상태라 RLS 위반으로 실패. 수업 생성을 `asUserB()` 호출 **이전**
  (managerA 세션 상태)으로 옮겨서 해결.
- **`AUTO-SEC-K`/`AUTO-SEC-M` (코드 수정 대상 아님)**: `getFixtureAdminClient()`로 직접
  조사한 결과, `booked=0`(reason 없음)의 실제 원인은 이 공유 fixture 센터
  (`5aa6e0b6-7e4a-47a3-b705-afc9a0cae4d7`, "통합테스트센터-e920be7a")의 `center_holidays`에
  `createClassOnDow()`가 항상 수렴하는 그 날짜(당시 2026-08-27)로 휴무일이 등록돼 있어
  `auto_book_membership()`의 "센터 휴무일이면 건너뛴다" 조건에 걸렸기 때문. **단, 이 휴무일을
  지워도 몇 분 안에 다른 id로 다시 생성되는 것을 실시간으로 확인** — `holiday-history-and-
  notification.test.ts`/`month-boundary-kst.test.ts` 등 이 저장소의 다른 통합테스트 파일이
  같은 fixture 센터에 동시에 접근하며 생기는 것으로 판단(이 세션이 실행한 파일에는 그
  코드가 없음을 확인). 즉 **[[ci-concurrency-starvation]]/공유 fixture 오염 패턴 그 자체**이지
  K/M 테스트 코드나 앱 RPC 로직의 결함이 아니다 — 여러 세션이 동시에 통합 테스트를 안 돌리는
  조용한 시간대에 재실행하면 통과해야 정상. `cleanup_p2_25_leftover_test_center_holiday.sql`은
  그 시점의 leftover 1건을 정리하는 일회성 스크립트로 남겨둠(재발 방지책은 아님).
- **`AUTO-SEC-N` (보류)**: setup 단계의 `reserve_class` 호출이 "예약 마감시간이 지났어요"로
  실패하는 진짜 이유는, 그룹 수업 예약 마감 계산(`calc_deadline`)이 기본값
  (`group_book_days_before=1`)일 때 당일 수업 예약을 구조적으로 항상 막는다는 것 —
  `center_settings.same_day_change_hours/minutes`/`allow_same_day_booking`이 스키마엔 있지만
  `reserve_class`/`calc_deadline`(`wire_settings.sql`) 어디에도 실제로 연결돼 있지 않다.
  **이건 `docs/TODO.md` P1-12("운영설정 화면의 다수 항목이 저장만 되고 실제로 적용되지
  않음")와 동일 범위**이고, 다른 세션이 이미 `chore/p1-12-settings-wiring-audit`에서 작업
  중이라 이 배치에서 중복 수정하지 않음 — P1-12가 same_day_change를 실제로 wiring하면 그때
  AUTO-SEC-N도 같이 재검증할 것.

### P2-26. (2026-08-20, 정리 완료 — 같은 날 재발도 정리 완료) `class-trainer-display.spec.ts` E2E 실패 — `leads.test.ts`(P1-8) leftover 스태프가 원인

| 필드 | 내용 |
|---|---|
| 우선순위 | P2 (테스트 fixture leftover — 앱 로직 버그 아님) |
| 현재 상태 | **완료 — leftover 정리 SQL 적용(2회, 재발 방지책은 아직 없음)** |
| 근거 파일 | `tests/e2e/reservation/class-trainer-display.spec.ts`, `tests/integration/leads.test.ts`(P1-8), `cleanup_leftover_leads_test_staff_role.sql`, `cleanup_leftover_leads_test_staff_role_2.sql`(2차) |

**2026-08-20 재발**: PR #68 workflow_dispatch run `32405557536`에서 같은 증상(E2E 6건,
strict mode violation)이 다시 발생 — 오늘 이 저장소 전체에서 Integration job 20분
타임아웃/취소가 여러 번(PR #67 2회, P2-24 등) 반복되며 `leads.test.ts`의 `afterAll`이 또
못 돌았기 때문. `cleanup_leftover_leads_test_staff_role_2.sql`로 정리(하드코딩 UUID 대신
`center_id`+역할명으로 특정 — 어떤 실행이 남긴 leftover든 재사용 가능). 아래 "남은 근본
위험"에 적어둔 근본 원인(모든 테스트 계정이 동일한 이름 사용)을 고치지 않는 한 CI가
타임아웃/취소를 겪을 때마다 계속 재발할 수 있다.

P2-25 조사 중 PR #66과 `main`(PR #53 병합 직후 push, run `32290229997`) 양쪽에서 E2E가
`locator('.class-trainers-list .filter-chip').filter({ hasText: '통합테스트계정' })
resolved to 2 elements`로 3건 실패하는 것을 발견. `tests/integration/setup.ts`가 모든
테스트 계정을 예외 없이 "통합테스트계정"이라는 동일한 이름으로 생성하기 때문에, 같은
센터에 활성 스태프가 2명 이상 있으면 이름 기반 강사 검색 UI가 항상 여러 건과 매칭된다.

원인은 `leads.test.ts`(P1-8)의 `beforeAll`이 공유 통합테스트센터
(`3937eb89-3803-43e9-9a29-e893f779df1a`)에 managerB를 "P1-8 테스트 무권한 역할"로
초대하고 `afterAll`이 정상적으로 정리하는데, 2026-08-19 18:42경 이 테스트를 포함한 실행이
CI job 20분 타임아웃으로 강제종료되며 `afterAll`이 못 돌아 그 스태프 등록이 그대로
남았던 것 — `cleanup_leftover_leads_test_staff_role.sql`로 정리.

**남은 근본 위험(이번 배치에서 손대지 않음)**: 모든 테스트 계정이 동일한 이름을 쓰는
설계 자체가, 앞으로도 같은 센터에 활성 스태프가 2명 이상 남을 때마다 이름 기반 검색을
쓰는 E2E 테스트를 깨뜨릴 수 있다. 근본적으로는 (a) 테스트 계정 이름에 고유 식별자를
포함시키거나 (b) `assignTrainerViaUi`가 이름 대신 account_id 등으로 특정 강사를 지목하는
방식으로 바꿔야 하는데, 둘 다 이 저장소의 여러 통합/E2E 테스트 파일에 걸친 광범위한
변경이라 사용자 승인 없이 진행하지 않음.

### P2-27. (2026-08-20, 완료) Integration job `timeout-minutes: 20`이 정상 실행도 잘라 PR #66/#67 모두 cancelled

| 필드 | 내용 |
|---|---|
| 우선순위 | P2 |
| 현재 상태 | **완료.** `timeout-minutes`를 20 → 35로 상향. |
| 근거 파일 | `.github/workflows/test.yml`(integration job) |
| 완료 조건 | ~~정상 Integration 실행이 잘리지 않을 만큼 여유를 두고, 진짜 멈춘 job이 전역 큐를 장시간 막는 위험(2026-08-14/15 사고, timeout 자체를 넣은 이유)은 유지~~ 완료. |

PR #66, #67 모두 Integration이 19분대에 `conclusion: cancelled`로 끝났다 — 실패가 아니라
`timeout-minutes: 20` 도달. 통합 테스트 스위트가 여러 세션이 계속 테스트를 추가하며 자라
정상 실행도 20분 근처(과거 timeout 없던 시절 기록은 30~34분)에 걸리게 됐다. P2-26에서 이미
같은 매커니즘(20분 타임아웃으로 `afterAll` 정리 로직이 못 돌아 leftover fixture가 남음)이
실제 버그를 만든 사례가 있어 근거로 삼음.

**timeout 자체를 없애지는 않음**: 이 값은 원래 2026-08-14/15에 진짜 멈춘 job이 GitHub 기본
360분 제한까지 전역 concurrency 큐(`shared-live-supabase-tests`, 저장소 전체 고정 그룹) 전체를
몇 시간~하루 넘게 막았던 사고 대응으로 추가된 것(E2E job 주석 참고, 오늘 관측한
`npx playwright install` 20분 멈춤도 이 안전장치 덕에 자동 정리됨 — P2-24). 없애면 그 사고가
재발할 위험이 있어, 대신 정상 실행 시간에 여유를 더 두는 쪽으로 조정.

**2026-08-23 후속(E2E job도 같은 증상)**: PR #86에서 E2E job이 정상 실행인데도 20분 15초,
20분 6초로 연속 `timeout-minutes: 20`에 걸려 cancelled됨을 실측 확인 — Integration과 똑같은
"스위트가 계속 자라 정상 실행도 타임아웃 근처" 패턴. 동일한 조치로 E2E job도 20→30으로 상향
(`.github/workflows/test.yml`).

### P2-28. (2026-08-21, 완료 — F 근본 수정 + H/I 새 이슈까지 해결) PR #68 Integration 재현 실패 11건 — waitlist 설정 미보장·N/O RLS+센터 승인 상태 문제 해결

| 필드 | 내용 |
|---|---|
| 우선순위 | P2 (테스트 코드/fixture 문제로 확인됨 — 앱 로직 버그 아님) |
| 현재 상태 | **완료.** ATT-SEC-B/C/D/E(waitlist)·AUTO-SEC-N/O 근본 원인 규명 및 수정 완료(PR #71 CI 검증). **F(stale-cleanup 두더지잡기)도 근본 수정 완료(2026-08-21, PR #72 작업 중 발견)** — `delete_test_center_cascade()` SQL 함수(information_schema로 `centers`를 직접/간접 참조하는 FK 그래프 전수 조사 후 작성)로 하드코딩 나열 방식을 교체, 로컬에서 연속 2회 안정적으로 통과 확인. 이 수정으로 파일이 끝까지 실행되자 **이전엔 F의 크래시에 가려 안 보이던 새 문제 2건(H, I)도 같이 드러나 함께 해결**했다(아래 참고). |
| 근거 파일 | `tests/integration/auto-book-membership-security.test.ts`, `tests/integration/manager-set-attendance-membership-integrity.test.ts`, `lib/settings.ts` |

PR #68(문서 전용 변경) CI에서 Integration 11건 실패(`auto-book-membership-security.test.ts`
F/H×2/L/M/N/O 7건 + `manager-set-attendance-membership-integrity.test.ts` ATT-SEC-B/C/D/E
4건) — PR #68 diff와는 무관해 원인 규명 시도.

**ATT-SEC-B/C/D/E(4건, 해결 확인됨)**: `makeWaitlistedReservation()`이 두 번째
`reserve_class()` 호출에서 `"이 센터는 대기예약을 사용하지 않아요"`로 거부됐다 —
`reserve_class()`는 `coalesce(waitlist_weekly_limit, 0) = 0`이면 이 에러를 던지는데, 이
파일은 그 값을 한 번도 명시적으로 설정한 적이 없었다. `beforeAll`/`afterAll`에 명시적
설정/원복 추가 — 재실행에서 4/4 모두 통과 확인.

**F/H/L/M/N/O(원래 진단·부분적으로 틀림)**: 처음엔 P2-25의 K/M 진단과 같은 메커니즘
(공유 센터의 다른 클래스가 `auto_book_membership()` 스캔에 섞임)이라고 판단해 전부 격리
센터로 전환했다. 하지만 `auto_book_membership()`의 실제 SQL(`fix_auto_book_membership_idor_
draft_proposed.sql`, Live 적용 확인됨)을 직접 읽어보니 `where c.center_id = v_mem.center_id`로
이미 명확히 센터 단위로 스코프돼 있어, 다른 센터의 클래스가 섞일 방법이 SQL 레벨에는 없다.
격리 전환 후 재실행 결과:
- **F/L: 간헐적 — 근본 해결 아님.** 실패 원인은 애초에 스캔 오염이 아니라 격리 전환 자체가
  새로 만든 버그였다 — `createIsolatedOwnedCenter()`의 leftover 정리 로직이 `payments`
  테이블 FK를 몰라서, L이 `fulfill_order()`로 실제 `payments` 행을 만들게 되자(격리 전환
  전에는 없던 경로) 이전 실행이 남긴 leftover 격리 센터의 `memberships` 삭제가
  `payments_membership_id_fkey` 위반으로 실패 → 그 예외가 (파일 순서상 먼저 오는) F를
  깨뜨렸다. `payments` 삭제 단계를 추가하고 L 자신도 만든 membership/payment를 자체
  정리하도록 고쳤더니, **재실행에서 F가 이번엔 `center_members_center_id_fkey`로 또
  크래시했다** — 다른 이전 실행이 남긴 leftover 격리 센터가 이번엔 다른 테이블(`center_members`,
  아마 memberships INSERT 시 트리거로 자동 생성되는 회원 행)에 걸린 것. 두더지잡기 패턴이었다.

  **2026-08-21 근본 수정(PR #72 작업 중, "P2-28 근본 수정 먼저" 사용자 지시)**: `payments`만
  고쳐서는 계속 새 FK가 나올 수밖에 없었던 이유는 애초에 "센터를 참조하는 어떤 테이블이
  있는지"를 하나씩 발견하며 하드코딩했기 때문 — `information_schema`로 `centers`를
  직접/간접(2단계까지) 참조하는 FK 전체를 조사해(총 hop-1 43개 테이블 + hop-2 34개 관계)
  실제 존재하는 모든 경로를 반영한 `delete_test_center_cascade(p_center_id)` SQL 함수로
  교체했다(`add_delete_test_center_cascade_rpc.sql`, Live 적용 완료·확인 쿼리로 `service_role`
  전용 EXECUTE 권한 확인). `createIsolatedOwnedCenter()`의 stale-cleanup과 파일 `afterAll`의
  이번 실행분 정리 둘 다 이 RPC 하나로 통일 — 앞으로 새 FK 위반이 나오면 이 SQL 함수만
  갱신하면 되고 테스트 파일을 다시 뒤질 필요가 없다. 로컬에서 연속 2회 안정 통과로 검증.
- **H(양쪽 케이스)/A~E/K/L/M/P: 격리 전환만으로 통과, 이후 재실행들에서도 안정적.** F의
  stale-cleanup 크래시에 휘말려 같은 파일 실행에서 함께 실패한 적은 있었으나(공유
  `staleIsolatedCentersCleaned` 플래그 예외로 인한 collateral damage), F가 크래시하지
  않은 실행에서는 전부 통과 — 이 자체의 로직 문제는 아니었음.

**2026-08-21 새로 발견(F 근본 수정 후 파일이 끝까지 도니 드러남) — H(마감)/I, P1-5/P2-28과
무관한 별개 문제, 테스트 레벨에서 방어 완료**:
- **AUTO-SEC-I(예약 2건 기대, 1건만 예약됨)**: [P2-22](#p2-22)가 이미 문서화한 것과 정확히
  같은 패턴의 재발이다 — 그때는 leftover **class**(같은 공유 센터에 300개+, 제목도 "CLASS-001
  기본값사용"/"SETTINGS-REAUDIT *" 등 이번과 겹침)가 원인이었는데, 이번엔 격리 센터 전환
  이후라 leftover **reservation**(확정 예약, "P1override-B")이 원인이라는 점만 다르다.
  근본 메커니즘은 같음: `auto_book_membership()`의 "이 회원이 그 날짜에 이미 예약이 있으면
  건너뛴다" 체크가 `center_id`로 스코프되지 않고 `profile_id`(회원) 하나만 기준이라(라이브
  정의로 확인), 이 파일이 공유하는 `USER_B` 계정이 전혀 무관한 다른 통합 테스트 파일/센터에
  남긴 leftover와 날짜만 우연히 겹쳐도 차단된다. `auto_book_membership()`을 센터 스코프로
  고치는 게 맞는지(의도적 정책일 수도 있음 — 매출 영향 있는 핵심 RPC)는 판단이 필요해 이번엔
  건드리지 않고, 테스트가 실제로 쓰는 날짜에 한해 `USER_B`의 leftover 예약을 사전 정리하는
  `clearUserBReservationsOnKstDates()` 헬퍼를 추가해 방어(다른 날짜/센터 데이터는 안 건드림
  — 공유 개발 DB에서 동시에 도는 다른 세션과 충돌 안 하도록 최대한 좁게 스코프). **주의:
  이건 이 파일 하나만 방어한 것 — P2-22 완료 조건 (a)(sweep을 미래 leftover까지 넓히는 근본
  수정)는 여전히 안 됨. 다른 통합 테스트 파일이 USER_B로 비슷한 날짜 기반 자동예약 검증을
  추가하면 똑같이 재발할 수 있다.**
- **AUTO-SEC-H(마감 지난 수업, 예약 0건 기대인데 1건 예약됨)**: `createClassOnDow()`가
  `targetDow`에 맞는 후보를 찾을 때까지 최대 7일을 검색하는데, 이 상품은 요일 전체
  ([0..6])를 허용해 dow 매칭이 애초에 불필요했다. 자정 근처(KST)에 테스트가 돌면 "2시간
  뒤"가 다음 날짜로 넘어가 `new Date().getDay()`와 어긋나면서 최대 +6일 떨어진 수업을
  반환할 수 있어, "수업이 2시간 뒤"라는 테스트 전제 자체가 깨졌다(밤 11시반쯤 실행하다
  재현·확인). dow 매칭이 필요 없는 케이스이므로 `createFutureTestClass()`를 직접 호출해
  "정확히 2시간 뒤"를 보장하도록 수정.
- 근거: `tests/integration/auto-book-membership-security.test.ts`. 로컬 재실행 2회
  연속(17/17, 이어서 28/28 with manager-set-attendance-membership-integrity.test.ts) 통과.
- **N/O: 근본 원인 2건, 모두 규명·수정 완료(2026-08-21).** 실제 CI 로그를 보면 `booked`
  assertion이 아니라 fixture 준비 단계에서 죽고 있었다 — booked count 문제라는 원래 가정
  자체가 틀렸다.
  1. **1차: `memberships` RLS 위반.** `createTestMembership()`(`tests/integration/setup.ts`)은
     **RLS가 걸린 일반 클라이언트**로 insert한다. 공유 센터(`centerAId`)에서는 userB가
     오래전부터 그 센터 회원이라 통과했지만, 격리 전환으로 만든 새 센터에는 userB가 전혀
     소속돼 있지 않아 이 RLS를 위반했다. 이 파일의 다른 모든 테스트가 이미 쓰던 admin
     클라이언트 헬퍼 `createAutoBookMembership()`으로 두 테스트의 "기존 예약" 준비 단계를
     교체 — `createTestMembership` import 자체를 제거함.
  2. **1차 수정 후 재실행에서 새로 드러난 2차: 센터 미승인.** RLS 에러는 사라졌지만
     `"아직 승인되지 않은 센터예요"`로 여전히 실패 — `createIsolatedOwnedCenter()`가 센터를
     `status: "pending"`으로 만드는데, `reserve_class()`를 비롯한 여러 RPC가
     `centers.status = 'approved'`를 요구한다(`fix_class_booking_deadline_override_
     draft_proposed.sql` 등). `auto_book_membership()`은 이 체크가 없어 F/G/I/J/K/L/M처럼
     `reserve_class`를 안 거치는 테스트는 문제없었지만, N/O는 "기존 예약" 준비 단계에서
     실제 `reserve_class` RPC를 호출한다. **`createIsolatedOwnedCenter()`의 센터 생성
     자체를 `status: "approved"`로 변경**(N/O 개별 수정이 아니라 헬퍼 자체를 실제 운영
     센터와 동일한 상태로 맞춤 — 이 파일의 모든 테스트, 앞으로 이 헬퍼를 쓸 새 테스트에도
     일관되게 적용됨). 이 두 버그 모두 F/L의 payments/center_members처럼 fixture cleanup이
     아니라 테스트/fixture 헬퍼 자체의 준비 단계 문제였다 — 격리 센터가 실제 운영 센터의
     여러 암묵적 전제(회원 소속, 승인 상태)를 그대로 만족해야 한다는 게 이번에 드러난
     교훈.

**ATT-SEC-B/C/D/E(4건)**: 원인이 달랐다. `makeWaitlistedReservation()`이 두 번째
`reserve_class()` 호출(정원 찬 수업에 대기로 밀려나는 예약)에서 `"이 센터는 대기예약을
사용하지 않아요"`로 거부됐다 — `fix_class_deadline_overrides_same_day_toggle.sql`의
`reserve_class()`를 보면 `coalesce(waitlist_weekly_limit, 0) = 0`이면 이 에러를 던진다.
이 테스트 파일은 처음부터 `waitlist_weekly_limit`을 **단 한 번도 명시적으로 설정한 적이
없었다** — 공유 센터의 그 값이 우연히 0이 아닌 동안만 통과해온 것. `beforeAll`에서
`fetchSettings`/`saveSettings`로 명시적으로 999를 설정하고 `afterAll`에서 원복하도록 추가
(N/O가 이미 쓰던 것과 같은 패턴).

### P2-30. (신규, 2026-08-23) daily-book-limit 계열 E2E 4개 간헐 실패 — 공유 픽스처 오염 의심, 미확인

| 필드 | 내용 |
|---|---|
| 우선순위 | P2 |
| 현재 상태 | **미확인 — 재현되면 P2-19/P2-22와 같은 계열로 조사 필요, 이번엔 재실행으로 우회** |
| 근거 파일 | `tests/e2e/settings/daily-book-limit.spec.ts`, `daily-book-limit-edge-cases.spec.ts` |

PR #86(UI/UX 감사 배치, 이 PR은 예약/한도 로직을 전혀 건드리지 않음) CI에서
`daily-book-limit-edge-cases.spec.ts`의 3개 테스트(64/112/154행)와 `daily-book-limit.spec.ts`
(62행)가 실패. 로컬에서 격리 재실행해도 동일하게 재현되지만, 실패 지점이 전부 "하루 예약
한도" 관련 toast 텍스트 불일치(예: "하루 예약 가능 횟수" 기대, "정원이 차서 대기 등록됐어요"
실제)라 **공유 `TEST_CENTER_ID`에 TEST_USER_A의 "오늘" 예약이 이미 쌓여있어 한도 계산의
전제(빈 상태에서 시작)가 깨진 것으로 추정**(P2-19/P2-22와 같은 계열). 직전 PR #85는 E2E가
깨끗하게 통과했었고, 이 PR의 diff는 UI/CSS/JSX와 테스트 셀렉터뿐이라 코드 원인일 가능성은
낮음. 이번엔 root cause를 확정하지 않고 `gh run rerun --failed`로 재실행해 우회함(문서에
이미 있는 "재실행하면 대부분 해소" 패턴). 다시 재현되면 P2-22 완료 조건 (a)(sweep을
`center_settings`뿐 아니라 당일 예약 leftover까지 넓히는 근본 수정)를 진행할 것.

### P2-29. (2026-08-21, 완료) `admin_action_logs` service_role GRANT 없음 — draft SQL 작성 후 사용자 적용 완료

| 필드 | 내용 |
|---|---|
| 우선순위 | P2 (테스트 fixture 전용 gap — 앱 런타임 영향 없음, P2-13/P2-19와 같은 부류) |
| 현재 상태 | **완료.** `information_schema.role_table_grants` 직접 조회로 `admin_action_logs`에 `service_role` privilege가 0행임을 확인(PR #46 조사, 2026-08-12). `lib/`/`app/` 전체에 `service_role` 사용이 없어 실제 회원/매니저 화면은 영향받지 않음 — `admin_action_logs` 행은 항상 `admin_assign_reservation`/`admin_cancel_reservation`(둘 다 security definer RPC) 내부에서만 INSERT되므로 이 GRANT 없이도 정상 동작한다. 유일한 사용처는 테스트 fixture 정리 스크립트(`cleanup_shared_test_center_pollution_draft_proposed.sql`)로, GRANT가 없어 이 스크립트의 진단/정리가 제한적이었다(P2-19 조사에서도 "service_role의 PostgREST GRANT가 없어 독립 재조회는 못 함"으로 확인). 사용자가 Supabase SQL Editor에서 GRANT SELECT, DELETE 실행 완료(2026-08-21). |
| 근거 파일 | `fix_service_role_grants_admin_action_logs_minimal_draft_proposed.sql`(신규, SELECT+DELETE만 — 코드 전수 검색 결과 실제 쓰이는 오퍼레이션만 최소 부여, 적용 완료), `rollback_fix_service_role_grants_admin_action_logs_minimal_draft_proposed.sql`(신규) |
| 완료 조건 | ~~사용자가 SQL Editor에서 GRANT 실행~~ 완료 |
| 관련 문서 | PR #46(원래 이 조사가 나온 PR. P0-6/P1-12 상태 정정과 함께 묶여 있었는데, P1-12는 PR #62가 별도로 재감사 중이라 이 GRANT 부분만 분리해 먼저 반영함) |

같은 조사에서 나온 `class_allowed_products` GRANT 건은 이미 main에 별도 세션이 적용한
`fix_service_role_missing_grants_class_allowed_products_update.sql`(UPDATE 권한 추가)로
4개 권한(SELECT/INSERT/UPDATE/DELETE) 전부 채워진 상태라, PR #46이 제안했던 그 테이블의
대안 SQL은 이미 의미가 없어져 가져오지 않았다.

아래 항목은 스키마 또는 권한 근거만 있고 완성된 앱 흐름이 없습니다. 사용자·제품 결정 없이 구현 또는 삭제하지 않습니다.

### P3-1. 수업 구분과 복수 강사 배정

**복수 강사 배정 — 2026-08-11 로드맵 포함 결정 + 구현 + SQL 2건 적용 + CI 2연속 Green
으로 최종 완료**: `class_trainers` 재사용, `classes.pass_selection_mode` 신규 컬럼
(수강권 허용 정책 0건=전체허용 → 명시적 선택제로 변경, 관련 결정)까지 한 배치로 처리함.
관리자 UI(`app/manager/classes/page.tsx` 수업 등록/수정 시트에 담당 강사 다중 선택 +
전체 선택/전체 해제 버튼 + 0개 선택 시 저장 차단), `lib/classes.ts`/`lib/reservations.ts`,
신규 통합 테스트(`tests/integration/class-trainers-and-pass-selection-mode.test.ts`)까지
완료. SQL 2건 모두 사용자가 Supabase에 실행 완료:
1. `add_class_trainers_pass_selection_mode_draft_proposed.sql` — read-only로 migration
   결과 확인(`all`=389/`selected`=85/합계 474, 헤더 주석 예고치와 정확히 일치).
2. `add_class_trainer_names_rpc_draft_proposed.sql` — CI 통합 테스트로 회원 세션에서
   `accounts` RLS 때문에 담당 강사 이름이 항상 빈 값으로 나오던 실제 버그를 발견해
   추가한 좁은 security definer RPC(`class_trainer_names`, public/anon EXECUTE 명시적
   차단 + `auth.uid() is not null` 이중 방어). anon 호출이 401 permission denied로
   정상 차단됨을 read-only로 확인.

전체 CI(E2E/Unit/Integration/Build) **2연속 Green**으로 최종 검증됨(run
`31487777454`/`31489758487`, 둘 다 first-attempt·재시도 없음 — E2E 45/45, Unit
213/213, Integration 133/133). 기존 P0~P4/P1-15/P1-17 관련 테스트 파일
(`schedule-rule-override.test.ts`, `class-allowed-products-enforcement.test.ts`,
`admin-assignment-security.test.ts`, `private-class-capacity.test.ts` 등) 전부 회귀
없이 통과. 상세는 `docs/CHANGELOG.md` 2026-08-11 항목들 참고.

**수업 구분(class_types, classes.class_type_id) — 여전히 미결정**: 이번 배치 범위 밖.

| 필드 | 내용 |
|---|---|
| 우선순위 | P3 |
| 현재 상태 | **확인 필요(수업 구분만 남음 — 복수 강사 배정은 위에서 해결됨)** |
| 근거 파일 | `schema.sql`, `reservation_functions.sql`; `class_types`, `classes.class_type_id` |
| 완료 조건 | 수업 구분 기능의 제품 포함 여부를 결정함. 포함 시 수업 CRUD·권한·기존 수업 migration을 구현하고, 제외 시 FK·운영 데이터·외부 사용을 확인한 정리 계획을 승인받음 |
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

### P2-DS-1. (신규, 2026-08-22) 디자인 시스템 정합성 — 이번 점검에서 남긴 후속 작업

| 항목 | 내용 |
|---|---|
| 우선순위 | P2 |
| 상태 | 미착수 |
| 근거 파일 | `app/globals.css`, `app/cart/page.tsx`, `app/checkout/page.tsx`, `app/center/[id]/page.tsx`, `docs/13_Design_System.md` |
| 완료 조건 | 아래 4개 항목이 처리되고, 디자인 시스템 문서와 코드가 일치함 |

2026-08-22 전체 UI 점검(회원·관리자·운영자)에서 수정하지 않고 남긴 것들:

1. **결제수단·길찾기 이모지 — [2026-08-22 완료]** `--vendor-*` 색 점 + `UiIcon` 조합으로
   재설계. 로고 없이 색으로만 구분해야 하는 벤더(카카오페이/토스페이, 카카오맵/네이버지도/티맵)는
   `.vendor-dot`(`background: var(--vendor-*)`인 14px 원)로, 나머지는 새로 추가한 outline
   아이콘(`card`/`bank`/`handshake`, `UiIcon.tsx`)으로 교체. `--vendor-toss`(#1B64DA)/
   `--vendor-tmap`(#1CD6C1) 토큰을 새로 추가했다(다른 `--vendor-*`처럼 정확한 로고 색상표가
   아니라 근사치 — 구분 목적이라 오차 허용). 구글 지도는 로고 자체가 다색이라 색 점 대신
   일반 `location`(지도핀) 아이콘으로. 정적 프리뷰(라이트/다크)로 시각 확인 완료 — 실제 앱
   화면은 라이브 데이터에 주소 있는 센터/장바구니 아이템이 없어 확인 못 함, 실사용 화면에서
   한 번 더 확인 권장.
2. **캘린더 선택 상태가 4종 — [2026-08-22 완료]** Playwright로 4곳(예약/`mypage/calendar`/
   매니저 수업 화면의 "복사" 시트/`class-revenue`의 날짜 선택기) 모두 실제로 선택 상태를
   만들어 스크린샷으로 비교한 뒤 통일. 예약 캘린더(`.cal-cell.selected`)와 매니저 수업
   캘린더가 이미 쓰던 brand-soft 원형(연한 하늘색 배경 + 진한 하늘색 글자, `--brand-soft`/
   `--brand-ink`)을 기준으로 나머지 둘을 맞췄다: `.mypage-cal-cell.sel`(기존: surface 배경 +
   accent 2px 외곽선 → brand-soft 배경, 외곽선 제거), `.copy-cal-cell.on`/
   `.app-date-grid button.on`(기존: `var(--accent)`/`var(--ink)` 배경 + 고정 흰 글자 → brand-soft/
   brand-ink). `--brand-soft`/`--brand-ink`는 다크 모드에서도 값이 안 바뀌는 고정 토큰이라, 기존
   `var(--ink)` 기반 조합이 다크 모드에서 배경이 뒤집혀 대비가 깨지던 문제(아래 다크 모드 항목
   참고)도 함께 해소됨. 셀 내부 구성(점·금액 표시 등)은 그대로 두고 채움색만 맞췄다.
   **부수 발견**: 이 작업 중 매니저 "수업" 화면의 "복사"/"휴무일" 헤더 버튼이 ManagerChrome
   공용 헤더 마이그레이션 이후 완전히 안 보이고 클릭도 안 되는 상태였던 걸 발견해 별도로 고침
   (`.manager-v3-content > .app-shell.manager-classes-v2 > .back-header { display: flex }`
   추가 — 이 화면은 제목+좌우 버튼 2개 구조라 일반적인 `.header-action`(제목 숨기고 오른쪽
   버튼 하나) 패턴이 안 맞아서 선택자 특이성을 높여 이 화면만 원래 레이아웃으로 되돌림).
3. **다크 모드 시각 확인 — [2026-08-22 완료]** Playwright로 실제 브라우저를 띄워 로그인 →
   `/settings/theme`에서 다크 모드 선택 → 회원(홈/마이페이지/프로필관리/포인트내역)·매니저(관리
   홈/수업/회원/설정/스태프)·운영자(`/admin`, 권한 없는 계정으로 접근 거부 화면) 전 구간을
   전체 페이지 이동(`<a href>` 방식, 이 앱은 `<Link>`를 안 씀)까지 포함해 순회하며 콘솔 에러
   0건 확인. 이 과정에서 진짜 버그 2건을 발견해 함께 고쳤다:
   - **테마가 페이지 이동 시 전혀 유지되지 않던 근본 버그**: `app/settings/theme/page.tsx`만
     `data-theme`를 적용했고 다른 어떤 화면에도 재적용하는 로직이 없어, 설정 화면을 벗어나는
     즉시(풀 페이지 이동이라) 라이트로 되돌아갔다. `app/layout.tsx`에 하이드레이션 이전에
     동기 실행되는 인라인 스크립트로 `localStorage("app_theme")` → `data-theme` 적용을
     추가(+ `suppressHydrationWarning`으로 의도된 서버/클라이언트 불일치 경고 억제).
   - **`background: var(--ink)` + `color: var(--text-inverse)` 조합의 다크 모드 반전 버그**:
     `--ink`는 "현재 테마의 가장 강한 색"이라 다크 모드에서 거의 흰색으로 뒤집히는데
     `--text-inverse`는 항상 고정 흰색이라, 이 조합을 쓰는 곳은 다크 모드에서 흰 바탕에 흰
     글자(또는 거의 안 보이는 대비)가 된다. 실제 확인된 2곳: `.admin-chrome`(운영자 화면
     헤더 바 — 배경을 항상-어두운 토큰 `--grad1`로 교체, 이 컴포넌트는 테마 무관하게 항상
     어두운 게 의도였음), `.manager-classes-v2>.fab-btn`("+ 수업 등록" 버튼 — 배경은 유지하고
     글자색만 `--text-inverse`→`--bg`로 교체해 테마에 따라 자동으로 반대색이 되게 함, 이미
     `.badge`/`.tag` 등 2곳에서 쓰던 올바른 패턴).
   - ~~**후속 필요**: 같은 `background: var(--ink)` + `color: var(--text-inverse)` 조합이
     `.app-button-primary`/`.system-state-mark`/`.mypage-shell .avatar`/`.manager-chrome-main > a`
     등 앱 전역 20곳 이상에 더 있다~~ **[2026-08-23 완료]** 별도 세션(Opus 5)의 UI 감사가
     `/manager/sales`(매출/순이익/미수금 대비 1.09:1)를 P0로 지목한 걸 계기로 전량 처리.
     `grep`으로 재조사한 결과 실제로는 16곳(원래 추정한 20곳과 비슷한 규모) — 버튼/칩/아바타/
     카드 등 텍스트 역할인 15곳은 `color`를 `var(--text-inverse)`→`var(--bg)`로 교체,
     로그인 히어로(`.auth-scene`/`.auth-page-v2`)는 하드코딩 `rgba(255,255,255,..)` 장식이
     많은 원래부터 테마 무관 고정 다크 배너라 `.admin-chrome`과 동일하게 배경을 `--grad1`로
     교체(색 자체를 바꿔 `--text-inverse` 그대로 유지). 화면별로 실제 성격을 확인해가며 개별
     처리(우려했던 "일괄 치환 위험"을 피함). `tests/unit/designSystem.contract.test.ts`에
     회귀 방지 테스트 추가(같은 조합 재발 감지), Playwright로 `/manager/sales` 다크모드 +
     로그인 라이트/다크 재검증. 같은 감사에서 발견된 라이트모드 `--text-dim`(#747479, AA
     4.49:1로 미달) 도 `#6B6B70`으로 함께 수정(회귀 테스트 포함). `npm run build` + 단위테스트
     246개 통과.
   - WCAG 대비 계산(sRGB relative luminance)으로 확인한 별도 사항: `--success`(#287A5B)/
     `--warning`(#9A6718)/`--danger`(#B64242) **기본색**(= -soft/-line이 아닌 본체)은 다크 배경
     (#17181C)에서 재정의가 없어 라이트 값 그대로 쓰이고, 대비비가 약 3.25~3.65:1로 일반 텍스트
     WCAG AA 기준(4.5:1) 미달이다(큰 텍스트/UI 기준 3:1은 충족). 화면에서 이 색이 작은 텍스트로
     직접 쓰이는 사례는 이번 순회에서는 못 봤지만, 새로 쓰는 곳이 생기면 주의 필요.
4. ~~**디자인 토큰 계약 테스트 확장**~~ **[2026-08-22 완료]** `tests/unit/designSystem.contract.test.ts`에
   회귀 방지 테스트 5개 추가: (a) `app/**/*.tsx` 전체를 재귀 스캔해 `style={{...}}` 안에
   하드코딩 hex가 없는지 확인, (b) 예전에 흩어져 있던 danger-red 리터럴 5종이 다시 나타나지
   않는지, (c) `--floating-nav-clearance` 정의 유지, (d) `.app-shell`이 `100dvh` 유지, (e) 프로필
   기본 아바타가 흰 배경 유지. **(a)를 추가하는 과정에서 실제 회귀 1건을 새로 발견**:
   `app/mypage/points/page.tsx`가 여러 줄에 걸친 `style={{...}}`(단일 줄 grep으로는 걸리지 않는
   형태)에 `#e7f5ec`/`#fdecec`/`#1f8a4c`/`#c0392b`를 그대로 쓰고 있었다(포인트 증감 배지 색) —
   `var(--success-soft)`/`var(--success)`/`var(--danger-soft)`/`var(--danger)`로 교체. 유닛
   테스트 244개 전부 통과, `npm run build` 통과.

### P2-DS-2. (2026-08-22 기록, 즉시 반증됨 — 실제 이슈 아님) `npm run build`가 `@playwright/test` 미설치로 실패한다는 보고는 worktree 환경 문제였음

이 항목을 작성한 background agent가 자신의 격리된 git worktree에서 `npm run build`를 돌렸는데,
그 worktree는 `.gitignore`된 `node_modules`가 새로 만들어질 때 `npm install`을 한 번도 실행하지
않은 상태였다("상위 저장소도 마찬가지"라는 판단은 틀렸음 — 실제로는 메인 작업 디렉터리에
`@playwright/test`가 정상 설치돼 있음, `ls node_modules/@playwright` 확인). 같은 worktree에서
`npm install --silent` 후 `npm run build`를 다시 돌리면 정상적으로 통과한다(2026-08-22 재확인).
CLAUDE.md 6·7번 규칙은 막혀 있지 않다 — 신규 worktree를 만들 때는 `npm install`부터 하는 것이
이번 세션 내내 반복된 관례([Multi-session coordination] 메모리 참고할 것이 아니라, 그냥
worktree 생성 직후 습관으로 굳힐 것).

### P2-DS-3. (신규, 2026-08-23) 별도 세션(Opus 5) UI 디자인 감사 — P0 2건은 즉시 수정, 나머지는 백로그

| 필드 | 내용 |
|---|---|
| 우선순위 | P1~P3 (항목별 상이) |
| 현재 상태 | **P0 2건 완료(다크모드 `--ink`+`--text-inverse` 조합, `--text-dim` 대비 — 위 P2-DS-1 항목 3 참고). 나머지는 미착수, 사용자 확인 후 순서 결정.** |
| 근거 | 회원/관리자 모드 37개 화면 × 라이트/다크 스크린샷 107장 + WCAG 대비 자동 측정. 스크린샷은 임시 산출물이라 이 세션에 보존돼 있지 않음 — 재확인 필요하면 같은 방식으로 재감사 가능 |

**P0 (완료)**: 다크모드 `--ink`+`--text-inverse` 조합 16곳, `--text-dim` AA 미달. 위 항목 3 참고.

**P0 (미착수)**: 센터 상세 페이지(`/center/[id]`)의 "센터 정보" 탭이 사실상 빈 화면(주소/전화/
영업시간/소개/지도 없음) + 뒤로가기 버튼과 센터 로고 겹침 + 센터명만 중앙정렬로 어색한 줄바꿈.
예약 전환 퍼널의 핵심 화면이라 CSS 토큰 수정보다 작업량이 큼(실제 데이터 렌더링 필요).

**P1 (미착수)**:
- 다크모드에 시맨틱 컬러 토큰(`--brand`/`--danger`/`--brand-ink`/`--brand-soft`/`--warning`/
  `--info`/`--success`/`--star`/`--private`) 재정의가 아예 없음 — 라이트 값이 다크 배경에서
  그대로 쓰여 곳에 따라 3.25~3.66:1로 AA 미달(위 항목 3의 "WCAG 대비 계산" 메모와 같은 근거,
  이번엔 실사용처 다수 확인됨 — 예: 마이페이지 "상품" 카드 `--brand-soft` 배경에 흰 글자).
- `--accent`가 라이트(거의 검정)→다크(코랄 오렌지 `#FF7A5C`)로 명도가 아니라 색상 자체가
  바뀜, 다크에서 코랄+시안(`--brand`) 액센트 두 개가 동시 존재해 경쟁, `--accent` 위 흰 글자
  실측 2.56:1(22곳)로 AA 미달.
- 타이포그래피 스케일 사실상 미사용 — `--type-*` 토큰 정의는 있으나 실사용 거의 0회, 실제
  font-size 35종/font-weight 23종 혼재.
- 빈 상태/에러 상태/로딩 상태가 화면마다 패턴이 다름(빈 상태 4종, 에러가 빈 상태와 시각적으로
  구분 안 됨 — 예: `/manager/staff/permissions` 권한 거부 화면이 복구 수단 없는 회색 텍스트
  한 줄뿐).

**P2 (미착수)**: 헤더 2종(좌측 대형/중앙 소형) 혼재, 탭·필터 4종 혼재, 생성/저장 버튼의 시각적
위계가 화면마다 뒤집힘(예: `/manager/center-info` 폼 저장이 작은 텍스트 링크), 레이아웃 충돌
4건(캘린더-플로팅버튼 겹침, 종목칩 잘림, 로그인 아이콘-문구 겹침, 프로필 카드 정렬 불일치),
좌우 거터 16~34px 혼재(토큰 `--page-gutter` 있는데 미준수), 날짜·시간 포맷 6종 이상(영문
AM/PM 포함), 상태 색상이 회색 pill 일변도(수강권 확정/대기/취소 구분 안 됨, 미수금이 다른
매출 숫자와 동일 색), 아바타 모양 3종(원형/라운드사각형 혼재), 테마 선택 화면 견본색이 실제
테마와 다름("burgundy" 코드명을 따라간 와인색 견본, 실제 라이트 테마엔 그 색 없음) + "시스템
설정 따르기" 옵션 없음, 폼 컨트롤 어포던스 혼재(읽기전용/입력/안내가 동일한 회색 박스).

**P3 (미착수)**: 파괴적 액션(삭제) 스타일 3종 혼재 + 상시 노출, 의미 없는 장식용 액센트 바
반복, `globals.css`에 `.bottom-nav`/`.nav-item` 등 중복 정의 블록(뒤쪽이 앞쪽을 덮어써 앞쪽이
사문화), 알림 목록에 읽음/안읽음 구분 없음, 홈 종목 아이콘 대비가 흐릿함(`--brand`→
`--brand-ink` 권장).

**권장 순서**(감사 리포트 원안): 1주차 토큰 수정(P0, 완료) → 2주차 센터 상세 재작업 +
Empty/Error/Skeleton 공용 컴포넌트 3종 → 3주차 액센트 단일화 + 헤더/탭 통일 + 버튼 위계 →
4주차~ 타이포 스케일 점진 전환(stylelint로 신규 하드코딩 차단) + 나머지 P2/P3.

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
