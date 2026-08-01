# CHANGELOG

이 저장소는 2026-07-26 `Initial commit`에 그 이전까지 개발된 기능이 통째로 들어왔습니다
(초기 개발은 zip 파일 전달 방식으로 진행됨 — `SETUP_INSTRUCTIONS.md` 참고).
따라서 **초기 스냅샷 이전의 기능별 이력은 Git 커밋만으로 알 수 없으며**, 이후 변경은 실제 commit과 아래 재구성 기록을 함께 확인해야 합니다.

아래는 두 가지 근거를 함께 사용해 재구성한 변경 이력입니다.
1. **Git 커밋 로그** (2026-07-26 이후, 실제 날짜 있음)
2. **SQL 마이그레이션 파일 + `TEST_CHECKLIST*.md` 문서**에 남아 있는 롤아웃 순서 (날짜 없음, 상대적 순서만 확인 가능)

## 2026-08-01 (추가) — SEC-007/008 단계 적용 준비 (ACL-003 재검증 반영)

ACL-003 서버 측 재검증에서 "센터 소속 = 무권한이라도 전체 접근 가능"이 실제 보안 결함으로
확인된 뒤, `add_rls_gap_tables_draft_proposed.sql`의 17개 테이블 정책 중 `my_managed_center_ids()`만으로
**쓰기**를 허용하던 6곳(class_types/lockers/locker_assignments/popup_notices의 쓰기,
notification_logs/change_logs의 조회)을 더 구체적인 `has_permission()` 권한 키로 좁혔습니다.
단일 파일을 4개 독립 배치(`proposed_rls_gap_batch_a/b/c/d.sql` + 짝 `rollback_rls_gap_batch_*.sql`)로
나눠, 배치별로 독립 적용·검증·rollback할 수 있게 했습니다. `staff_schedules`/`schedule_memos`의
조회는 낮은 민감도의 캘린더 조율 정보라는 이유로 센터 전체 조회를 의도적으로 유지했고, 이를
"정당화된 예외"로 문서에 명시했습니다. 17개 테이블 재분류표와 역할×테이블 접근 매트릭스(7번째
열 "타 센터 owner/staff" 추가 — 전부 차단됨을 명시)를 `docs/21_RLS_Gap_Analysis.md`에 반영했습니다.
Fixture 계획도 갱신: TEST-002에서 검증된 "TEST_MANAGER_A/B 두 계정만으로 오너+무권한 스태프
페르소나 생성" 패턴을 재사용해, platform admin 테스트 계정 1개를 제외하면 **새 GitHub Secrets가
전혀 필요 없습니다.** 이번 배치도 실제 SQL은 실행하지 않았습니다.

## 2026-08-01 — RLS 조사 및 설계 Batch (DB-001, SEC-007·008)

`docs/rls-gap-design` 브랜치(PR B)에서 진행. 조사·설계만 진행했고 운영 DB에는 아무것도
실행하지 않았습니다. 이 이슈들은 PR이 머지돼도 자동으로 닫히지 않습니다(Relates to만 연결) —
실제 정책 적용과 QA가 끝나기 전에는 Done으로 바뀌지 않습니다.

**DB-001 — `chat_messages` 조사**: app/lib 전체·모든 SQL 함수/트리거/뷰에서 참조 0건, RLS는
활성화돼 있으나 정책 0건(현재 완전 차단 상태). 1:1 채팅은 `inquiry_threads`/`inquiry_messages` +
RPC로 완전히 대체되어 있음을 확인. **결론: 정책 추가가 아니라 삭제 후보** — 이번 배치는 DROP을
실행하지 않았고, 사용자 승인 후 별도 배치에서 처리하도록 `docs/TODO.md` P3-9에 기록.

**SEC-007/SEC-008 — RLS 갭 분석 및 정책 설계**: `schema.sql` + 저장소의 모든 `*.sql`을 전수 매칭해
RLS가 없거나 정책이 0건인 테이블 18개를 찾았고, `chat_messages`(DB-001에서 별도 처리)를 제외한
17개(`change_logs`, `class_types`, `community_comments`, `competitions`, `contract_templates`,
`contracts`, `leads`, `locker_assignments`, `lockers`, `membership_transfers`, `messages`,
`notification_logs`, `popup_notices`, `schedule_memos`, `staff_salaries`, `staff_schedules`, `terms`)에
대해 목적/개인정보/tenant scope/현재 사용여부/예상 접근 역할/SELECT·INSERT·UPDATE·DELETE 정책초안/
기존 데이터 영향/회귀 가능성/테스트 시나리오/우선순위를 정리한 `docs/21_RLS_Gap_Analysis.md`를
작성했습니다. 17개 전부 app/lib 코드 참조 0건(미구현 기능)이라 지금 당장의 활성 위험은 아니지만,
Supabase는 anon key만으로 PostgREST를 통해 이 테이블에 직접 접근 가능하므로 "미사용 = 안전"이 아닌
잠재 위험으로 분류했습니다. `staff_salaries`(급여)와 `contracts`(서명 계약서)는 Critical로 표시.
정책 초안은 `add_rls_gap_tables_draft_proposed.sql`에 작성했으며 **이번 배치에서는 실행하지
않았습니다** — 실행은 별도 승인 후 후속 배치에서 진행합니다. RLS 통합 테스트 계획(6개 역할 ×
17개 테이블 CRUD 매트릭스 + fixture 요구사항)도 같은 문서에 설계만 해뒀고 실제 DB 테스트는
실행하지 않았습니다.

## 2026-07-30 (추가) — 관리자 직접배치 통합 테스트 성공 경로 보강

이전 커밋의 `admin-assignment-security.test.ts`는 매니저 fixture가 없어 권한 차단·입력 검증만
다뤘습니다. 이번 추가 작업으로 서비스 역할 키 없이 테스트가 스스로 매니저/센터 fixture를 만들도록
`tests/integration/setup.ts`에 `getOrCreateOwnedTestCenter()`/`createFutureTestClass()`/
`createTestMembership()`/`cleanupTestClass()`를 추가했습니다(앱의 실제 매니저 가입 RLS 정책만
사용 — `centers`/`manager_centers` insert가 로그인 사용자면 허용되는 기존 정책을 그대로 활용).

- 신규 환경변수 `TEST_MANAGER_A_EMAIL`/`PASSWORD`, `TEST_MANAGER_B_EMAIL`/`PASSWORD` 추가
  (get-or-create, `tests/README.md`·`.env.test.local.example`·`.github/workflows/test.yml`에 반영).
- ADMIN_ASSIGNMENT/ADMIN_FREE 정상 생성, 이용권 없음/만료 회원 성공, 취소 시 수강권 복구/미변화,
  `admin_action_logs`·회원 알림 생성, 동시 요청 단일 생성, 다른 센터 관리자 차단 — 10개 성공 경로
  테스트 추가.
- 테스트 작성 중 실제 버그 발견 및 수정: `add_admin_assignment.sql`의 알림 트리거가 회원 알림
  `data` metadata에 `reservation_type`(ADMIN_ASSIGNMENT/ADMIN_FREE)을 그대로 담고 있어, 회원이
  자신의 알림 원본 데이터를 조회하면 무료 추가 배치 여부를 알 수 있는 정보 노출이 있었음
  (§16 정책 위반). `reservation_id`/`class_id`/`action`만 남기도록 수정하고, 회귀 테스트로 고정.
- 정원 초과 확인(`needs_capacity_confirm` → `p_force_capacity`) 2단계 흐름 자체는 이번에도
  자동화하지 못함 — `docs/TODO.md` P1-11에 남은 범위로 재기록.

## 2026-07-30 — 예약 UX 개선 + 관리자 직접배치/무료 추가 배치 (`feature/p1-reservation-ux`)

### 왜 바꿨는가

관리자가 미배치 요일반 수강권을 "다시배치"(자동 재시도)만 할 수 있고, 날짜·수업을 직접 골라
회원을 배치하거나 수강권 없이 무료로 추가 예약을 넣어줄 방법이 없었습니다. 또한 예약 화면에
구매용 상품(goods)이 "사용 가능한 수강권" 목록에 잘못 섞여 보이는 버그, 구매 완료 문구의 어색한
표현, 예약 화면의 중복 계정 조회 등 성능 이슈가 있었습니다.

### 무엇을 바꿨는가

- **예약 타입/출처 구조화**: `reservations.reservation_type`(MEMBER/ADMIN_ASSIGNMENT/ADMIN_FREE),
  `reservation_source`(USER/ADMIN/SYSTEM), `admin_reason_code`/`admin_reason_detail`,
  `is_capacity_override`, `membership_consumed`, `cancelled_by`/`cancel_reason`/`cancelled_at`,
  `created_by_account_id`, `updated_at` 컬럼 추가 (`add_admin_assignment.sql`, text+CHECK 방식 —
  기존 `status`/`pass_type`/`product_kind` 등 다른 모든 상태 컬럼과 동일한 관례).
- **관리자 직접배치/무료 추가 배치 RPC 신설**: `admin_assign_reservation`(일반 직접배치는 수강권
  종류·예약 가능 시간 제한 무시하고 기존 수강권/미배치건 차감, 무료 추가배치는 차감 없음),
  `admin_cancel_reservation`(타입별 정확한 복구 + 중복 취소 방지). 권한 검사는 기존
  `manager_book_member`와 동일한 "센터 활성 매니저 OR 플랫폼 운영자" 정책을 `can_manage_center_reservations()`
  헬퍼로 분리해 재사용 — 향후 세부 permission key 확장 지점으로 남겨둠. 회원 자격 검사도
  `is_profile_assignable()`로 분리(현재는 기존 셀프예약과 동일하게 프로필 존재 여부만 확인).
- **관리자 예약 작업 로그**: `admin_action_logs` 테이블 신설(append-only, 일반 매니저 UI에서
  수정·삭제 불가 — update/delete RLS 정책을 아예 만들지 않음).
- **기존 함수 확장(회귀 없음)**: `reserve_class`/`reserve_with_membership`/`manager_book_member`/
  `cancel_reservation`/`manager_set_attendance`는 반환값과 기존 로직을 그대로 두고 새 컬럼만 채우도록
  `create or replace`. `manager_book_member`(기존 "보강예약")는 수강권+차감 여부에 따라
  ADMIN_ASSIGNMENT/ADMIN_FREE로 자동 태깅.
- **알림 트리거 확장**: `trg_notify_reservation_insert`/`_update`가 `reservation_type`에 따라
  분기 — 관리자 배치/취소는 회원에게 "관리자가 예약을 등록/취소했습니다"만 안내(무료 여부·사유·
  관리자명·정원초과 등 내부 정보 비공개), 다른 매니저에게는 알리지 않음(소음 방지).
- **버그 수정** (`fix_usable_memberships_product_kind.sql`): `usable_memberships()`/
  `usable_memberships_for_classes()`가 `products.product_kind`를 확인하지 않아 구매용 상품(goods)이
  "사용 가능한 수강권" 목록과 예약 확인 팝업에 섞여 보이던 문제 수정. `remaining_count` NULL(기간권)
  처리도 함께 바로잡음.
- **구매 완료 문구 수정**: 기본 "상품 구매가 완료되었습니다.", 실제 이용 가능한 수강권이 즉시
  발급된 경우에만 "상품 구매가 완료되었으며 이용 가능한 수강권이 등록되었습니다." (`app/checkout/page.tsx`,
  `app/reservation/page.tsx`).
- **예약 화면 성능 개선** (`app/reservation/page.tsx`, `lib/reservations.ts`): `fetchMonthData`/
  `fetchMyProfiles`가 각각 중복으로 `auth.getUser()`+`accounts` 조회를 하던 것을 `getMyAccountId()`
  한 번 조회 후 `Promise.all`로 병렬화. `dayClasses`/`categoryCenterIds`를 `useMemo`로 감싸 매
  렌더링마다 새 배열·Set을 만들지 않게 함(특히 `categoryCenterIds`는 `dayClasses`의 `useMemo` 의존성으로
  쓰이므로, 메모이제이션하지 않으면 dayClasses 메모도 매번 무효화되는 연쇄 문제가 있었음). 수강권 이름
  Set을 매 행마다 새로 만들던 `usableProductNames`를 `usablePassesByClass` 변경 시 한 번만 계산하는
  `Map`으로 변경. `doReserve`/`handleCancel`에 재진입 방지 가드 추가. 로딩 텍스트에 은은한 shimmer
  애니메이션 추가.
- **관리자 UI** (`app/manager/classes/page.tsx`): "미배치 수강권" 시트의 각 행에 "직접배치" 버튼 추가,
  신규 "회원 직접배치" 진입 버튼으로 회원 검색 후 기존 캘린더 위에서 날짜·수업을 고르는 방식 지원,
  배치 방식(일반 직접배치/무료 추가 배치) 확인 팝업 + 사유 선택 + 정원 초과 추가 확인, 예약자 명단에
  관리자 배치 배지와 "관리자 배치 취소" 액션 추가.
- **관리자 배치 내역 조회 화면 신설**: `app/manager/admin-assignments/page.tsx` (기간/회원·관리자·수업
  검색/타입/작업/사유/정원초과 필터 — 통계·엑셀 다운로드는 이번 범위 제외).
- **회원 화면**: `app/my-reservations/page.tsx`에 관리자 배치 예약 배지 표시(ADMIN_ASSIGNMENT/ADMIN_FREE
  구분 없이 "관리자 배치 예약"으로만 노출).

### 알려진 제한 (docs/TODO.md에 항목으로 기록)

- 세부 permission key(`schedule.admin_assign` 등)와 회원 상태(이용정지/탈퇴/휴면) 차단 정책은 이번
  범위에서 결정하지 않고 확장 지점만 마련함 (사용자 확인 결과).
- 통합 테스트는 매니저/오너 테스트 계정 fixture가 없어 권한 차단·입력 검증 경로만 검증했고, 실제
  배치 성공·정원초과·취소 복구 경로는 수동 테스트로 확인함.

## 2026-07-28 — 프로젝트 문서 리팩터링 (커밋 전)

### 변경 성격

이번 작업은 **기능 변경이 아닌 문서 전용 리팩터링**입니다.

- `app/`, `lib/`, 루트 SQL, package·환경·배포 설정을 수정하지 않았습니다.
- 앱 기능, 라우트, 테이블, RPC, RLS 또는 trigger를 새로 구현하지 않았습니다.
- SQL migration을 생성하거나 Supabase에 적용하지 않았습니다.
- Git commit·push와 Vercel 배포를 수행하지 않았습니다.
- 문서의 기능 상태는 현재 코드와 SQL을 직접 확인해 재분류했으며, 운영 환경에서 확인할 수 없는 내용은 `확인 필요` 또는 `운영 설정 필요`로 유지했습니다.

### 변경 문서

| 문서 | 구조 개선 내용 |
|---|---|
| `docs/REQUIREMENTS.md` | 문서 역할과 판정 기준, 프로젝트 목표, 개발 상태, 사용자별 기능, 비즈니스·UX 요구사항, 로드맵과 AI 갱신 규칙으로 재구성. `구현됨`·`미완성`·`확인 필요`·`운영 설정 필요` 상태를 분리 |
| `docs/DATABASE.md` | `app/`·`lib/`가 직접 참조하는 테이블 36개를 검증하고 연결 상태를 구분. 향후 기능 후보 23개와 용도·존속 여부 확인이 필요한 미사용 테이블 5개를 분리하고 보호 테이블, 핵심 RPC·RLS·trigger와 SQL 적용 상태를 정리 |
| `docs/ROUTES.md` | 실제 `app/**/page.tsx` 41개를 기준으로 사용자 유형, 기능, 데이터 의존성, 권한 처리와 미완성 상태를 라우트별로 정리 |
| `docs/AI_PLAYBOOK.md` | ChatGPT, Claude Code/Codex, NotebookLM, Graphify, GitHub, Vercel의 책임·금지 작업·필수 인계 정보를 명확히 하고 기능·버그·DB 작업 절차를 재구성 |
| `docs/WORKFLOW.md` | `NotebookLM → ChatGPT → Claude Code/Codex → 로컬 테스트 → GitHub → Vercel → Graphify·문서 갱신` 표준 흐름과 단계별 입력물·작업·결과물·검수 기준을 정의 |
| `docs/DEVELOPMENT_RULES.md` | 현재 Next.js·TypeScript·Supabase 구조에 맞춰 SQL migration, 환경변수, 권한, 데이터 무결성, UI 상태, 로컬 검증, Git과 문서 갱신 규칙을 구체화 |
| `docs/TODO.md` | REQUIREMENTS와 DATABASE 및 기존 문서의 미완성·확인 필요·운영 설정 필요 항목을 P0~P3의 30개 작업으로 통합하고 각 항목에 근거와 완료 조건을 추가 |
| `docs/CHANGELOG.md` | 이번 문서 리팩터링의 범위와 비기능 변경 사실을 기록 |

### 검증과 정정

- 실제 라우트 41개와 ROUTES의 41개 항목이 일치하는지 확인했습니다.
- `app/`·`lib/`의 직접 참조를 기준으로 현재 사용 테이블과 코드 미사용 테이블을 다시 분류했습니다.
- 기존 문서의 “코드 미사용 테이블 27개”를 실제 목록 수인 28개로 정정했습니다.
- 요일반 자동예약 재시도는 `app/manager/classes/page.tsx`에 “다시 배치” UI가 존재하므로 구현된 기능으로 정정했습니다.
- SQL 파일 67개와 앱이 호출하는 핵심 RPC를 대조했으며, 여러 migration에서 재정의되는 함수와 운영 DB 적용 상태는 완료로 단정하지 않았습니다.
- 문서 간 상세 중복을 줄이고 REQUIREMENTS, DATABASE, ROUTES, TODO, 절차 문서가 각자의 책임을 갖도록 상호 링크를 정리했습니다.

## Git 커밋 이력 (실제 날짜 확인됨)

| 날짜 | 커밋 | 내용 |
|---|---|---|
| 2026-07-30 | (커밋 전, `feature/p0-test-payment`) | **fix(ci): GitHub Actions Node.js 20 → 22** — `PaymentProviderFactory.test.ts`가 CI에서만 실패(로컬 Node 24는 통과). 원인: `@supabase/supabase-js`(realtime-js)가 클라이언트 생성 시 native `WebSocket` 전역을 요구하는데 Node 20엔 없음 — 이 테스트는 mock 없이 `lib/supabaseClient.ts`까지 실제로 import하는 체인이라 import 단계에서 바로 실패함. `.github/workflows/test.yml`의 `node-version`을 22로, `package.json`에 `engines.node: ">=22"`, `.nvmrc` 신규 추가. 근본 원인(단위 테스트가 Supabase 클라이언트 초기화에 우연히 의존하는 구조)은 아직 안 고침 — `docs/TODO.md` P2-9에 기록 |
| 2026-07-30 | `64d3d67` | **P0-1 결제 시스템 자동 테스트 환경 구축** — Vitest 신규 도입(`vitest`/`dotenv` devDependency 추가). `npm run test`(단위, Supabase 불필요, `tests/unit/`)와 `npm run test:integration`(실제 개발용 Supabase에 실제 RPC 호출, `tests/integration/`), `npm run test:all` 3개 스크립트 신설. 단위 테스트는 `mockPaymentApi`를 mock해 `MockPaymentProvider`의 success/failed/cancelled 분기와 `PaymentProviderFactory`의 provider 선택 로직만 검증(12개, 항상 통과 가능). 통합 테스트는 실제 계정 2개(A/B, get-or-create 방식 — 없으면 자동 가입 후 `accounts`/`profiles` 생성, 있으면 재사용)로 로그인해 성공/취소 결제, 순차·동시(`Promise.all`) idempotency, RLS(본인 소유·mock 전용 가드), 존재하지 않는 주문 등 실제 DB 상태까지 검증. `.env.test.local.example` 템플릿 신설(`.gitignore`에 `.env*` 예외 추가로 커밋 대상 포함). `.github/workflows/test.yml` 신설 — 매 push/PR에 단위 테스트, 같은 저장소 브랜치 간 PR·push·수동실행에 통합 테스트(fork PR은 Secrets 미주입으로 제외). UI/UX 테스트는 자동화 범위에서 제외(사용자가 직접 수행) |
| 2026-07-30 | `c3bb9f2` | **P0-1 테스트 결제 환경 구축** — Payment Adapter Pattern(`Checkout → PaymentService → PaymentProviderFactory → PaymentProvider interface → {Mock\|Toss\|PortOne}`) 신설. `lib/payments/`(신규 7개 파일): `types.ts`(인터페이스+DTO), `MockPaymentProvider.ts`(success/failed/cancelled 3개 시나리오 실동작, `NEXT_PUBLIC_PAYMENT_SCENARIO` 또는 checkout `?mockScenario=` 쿼리로 선택), `TossPaymentProvider.ts`/`PortOnePaymentProvider.ts`(구조만), `PaymentProviderFactory.ts`(`NEXT_PUBLIC_PAYMENT_PROVIDER`로 전환), `PaymentService.ts`, `index.ts`. `add_payment_test_provider.sql` 신규 — 회원 본인 전용 `confirm_test_payment`/`cancel_test_payment` RPC 2개(`orders.payment_provider` 컬럼 1개 추가, `schema.sql`은 무수정). **`fulfill_order`(add_order_fulfillment.sql)는 절대 수정하지 않고 로직 중복을 의도적으로 허용** — 매니저 전용 권한 모델과 회원 본인 확정 모델이 근본적으로 다르기 때문(사유·공통화 방안·향후 계획은 `docs/TODO.md` P0-1 참고). `app/checkout/page.tsx`의 `handlePay()`만 수정(라우트/기존 UI 요소 불변) — Mock 결제 성공 시 실제로 수강권이 즉시 발급되도록 연결. `app/reservation/page.tsx`는 무수정(기존 "즉시 가능/발급 대기" 토스트 분기 로직이 실제 DB 상태를 재조회해 판단하도록 이미 설계돼 있어, Mock 성공 시 자동으로 "바로 예약 가능" 문구가 나옴). `lib/orders.ts`는 `createOrder()`에 선택적 `provider` 필드 1개만 추가(하위 호환, `app/cart/page.tsx` 등 기존 호출부 영향 없음) |
| 2026-07-28 | `e412cd9` | `fix_usable_memberships_shared.sql` 추가: 수강권 조회·예약 RPC를 계정 공유 기준으로 통일하고 `usable_memberships_for_classes()` 배치 RPC 정의. 운영 Supabase 적용 여부는 저장소만으로 확인할 수 없음. 관련 프로젝트 개요 문서 보강 |
| 2026-07-28 | `40f22b6` | 예약 → 수강권 구매 → 주문 접수 → 예약 화면 복귀 UX 개선. 구매 가능한 상품 배치 조회, 수강권·굿즈 조회 경합 방지, 기본 수강권 선택, 센터·checkout 복귀 URL 유지, 주문 후 발급 상태 안내를 포함. 실제 PG와 즉시 수강권 발급을 추가한 변경은 아님 |
| 2026-07-28 | `345d5e0` | AI 작업 규칙과 도구 협업 문서 추가 (`CLAUDE.md`, `AI_PLAYBOOK.md`, `WORKFLOW.md`) |
| 2026-07-28 | `f6058e7` | REQUIREMENTS, DATABASE, ROUTES, TODO, DEVELOPMENT_RULES, CHANGELOG 초기 문서 추가 |
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
  - `lockers`/`locker_assignments`(락커)는 `schema.sql`의 최초 설계에 테이블만 포함되었고, 재검증 결과 실제 화면/코드는 없는 것으로 확인됐습니다([DATABASE 5절](./DATABASE.md#5-향후-기능-후보-테이블)) — "커밋 이전 롤아웃"이 아니라 "설계됐지만 만들어지지 않은 기능"입니다
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
