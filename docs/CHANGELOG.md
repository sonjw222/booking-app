# CHANGELOG

이 저장소는 2026-07-26 `Initial commit`에 그 이전까지 개발된 기능이 통째로 들어왔습니다
(초기 개발은 zip 파일 전달 방식으로 진행됨 — `SETUP_INSTRUCTIONS.md` 참고).
따라서 **초기 스냅샷 이전의 기능별 이력은 Git 커밋만으로 알 수 없으며**, 이후 변경은 실제 commit과 아래 재구성 기록을 함께 확인해야 합니다.

아래는 두 가지 근거를 함께 사용해 재구성한 변경 이력입니다.
1. **Git 커밋 로그** (2026-07-26 이후, 실제 날짜 있음)
2. **SQL 마이그레이션 파일 + `TEST_CHECKLIST*.md` 문서**에 남아 있는 롤아웃 순서 (날짜 없음, 상대적 순서만 확인 가능)

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
