# 일반 CI의 공유 DEV DB 쓰기 경로 감사 + 안전한 CI 구조 설계안 (2026-10-15, 정적 분석 — DB 접근 없음)

방법: workflow·vitest/playwright 설정·테스트·fixture 소스를 읽고 호출 경로를 추적(실행 없음). 개별 테스트 53개의 의미까지 전수 검증한 것은 아니며, 아래 "확인 수준" 열에 구분했다.

## 1. 실행 조건 (GitHub Actions)
| workflow | 트리거 | live DEV 사용 |
|---|---|---|
| `test.yml` | push(main), **pull_request(전체)**, workflow_dispatch | **pull_request/dispatch**: 같은 저장소 PR이면 E2E 4구간 + Integration 실행(포크 PR·push는 live job 제외). 전역 concurrency 큐 1개 |
| `admin-pagination.yml` | PR(경로 한정), dispatch | 아니오(PGlite, secrets 없음) |
| `dev-agent.yml` | PR(경로 한정), dispatch | 아니오(secrets 없음) |
| `mobile-ui-qa.yml` | dispatch + ACK 입력 | **Production**을 여는 의도적 QA(ACK 없으면 job 미시작) — 본 감사 범위 밖, 변경 없음 |
→ 같은 저장소의 **모든 PR push가 공유 DEV에 쓰는 live job을 자동 실행**한다.

## 2. 공유 DEV에 쓰는 경로 (service role = RLS 우회)
| # | 경로 | 쓰기 내용 | 정리 | 확인 수준 |
|---|---|---|---|---|
| 1 | Integration `globalSetup.ts` | 공유 테스트 센터 `center_settings` upsert(일일 예약 한도 해제) → 종료 시 원복 | 종료 훅. **취소/timeout 시 원복 보장 없음** | 코드 확인 |
| 2 | `getOrCreateOwnedTestCenter`(39개 파일이 호출) | 전용 센터 `통합테스트센터-*` 생성 가능, 1시간 이상 지난 수업 스윕 삭제 | 파일 afterAll(+자기치유 스윕) | 코드 확인, 파일별 정리는 미검증 |
| 3 | Integration 53개 파일 중 service role 사용 **38개**, 직접 INSERT/UPDATE/UPSERT/DELETE 동사 사용 **40개** | 센터·수업·상품·수강권·결제·예약·정책 설정 생성/삭제 | afterAll 위주. 1개 파일만 `delete_test_center_cascade` 사용 | 정규식 스캔(동사·파일 수만). 개별 의미는 미검증 |
| 4 | Integration의 RPC 호출(상위: `reserve_class` 67, `admin_assign_reservation` 29, `cancel_reservation` 22, `manager_set_attendance` 21, `reserve_with_membership` 20, `auto_book_membership` 17, `confirm_test_payment` 15 …) | 예약·취소·출석·결제 확정(테스트 결제)·환불·`fulfill_order`·`create_announcement`·`create_marketing_message_safe` 등 | 파일별 | RPC 이름 집계 |
| 5 | 서비스 롤을 **쓰지 않는** 15개 파일(예: payment-lifecycle, leads, sec009-a1) | 테스트 계정 세션으로 lib/RPC를 통해 쓰기 가능(RLS 적용) | — | 파일 목록만, 내용 미검증 |
| 6 | Auth 사용자 생성/삭제(`auth.admin.createUser/deleteUser`) 5개 파일 | 임시 auth 계정·accounts | 각 afterAll | 코드 확인 |
| 7 | E2E `fixtures/testData.ts` + 스펙 다수 | 공유 `TEST_CENTER_ID`에 수업·**상품(`getOrCreateTestPassProduct*`)**·수강권·일정규칙 생성, **`deleteExistingClassesByTitle`로 같은 제목 기존 수업 + 그 예약 삭제**, `cleanupTodaysReservationsForProfile`로 테스트 프로필의 오늘 예약 삭제 | 스펙별 afterEach/afterAll | 코드 확인 |
| 8 | E2E UI 흐름(예약·결제 `direct-payment`, `member-full-lifecycle`, 취소) | 테스트 계정으로 예약·직접결제·취소 | 스펙별 | 이름·헬퍼 확인, 흐름 미검증 |
| 9 | Integration 관리자 승격/전역 요금제(`subscription-plan-limits`, `sec009-batch-a2-rls` 2건, AUTO-SEC-K) | 공유 계정 `is_platform_admin` 임시 true, 기본 요금제 변경 | finally(취소 시 보장 없음) | **커밋 a179f30으로 일반 CI에서 제외/SKIP** |
| 10 | `acl-fixture-repeat` | integration 3개 파일 반복 | — | 특정 head_ref에서만, 승격/요금제 코드 없음(grep) |
| 11 | 이번 작업에서 제거 | PR #229 fixture(승격 + 센터 93개) | — | **커밋 1259354로 제거** |

읽기 전용(DB 쓰기 없음): unit, lint, tsc, build(placeholder env), `sql` job(PGlite), `live-env-preflight`(네트워크 없음), Playwright `--list`, 신규 정적 안전 테스트들.

## 3. 취소·timeout 시 잔여 위험 (코드 근거, 실측 아님)
- Integration job timeout 35분 vs 정상 실행 30~34분: 중간 취소 이력이 workflow 주석에 있음. afterAll/finally는 SIGKILL·러너 종료 시 실행 보장 없음.
- 잔여 가능 대상: 전용 센터·수업·수강권·결제·임시 계정, 공유 센터 `center_settings`(globalSetup 원복 누락 시), E2E가 만든 상품·일정규칙. 다음 실행의 스윕/자기치유로 일부만 회복.
- 권한 승격과 기본 요금제 변경은 일반 CI에서 제거했으므로 이 잔여 경로는 닫힘(수동 스위트는 읽기 전용 사전검사 + BLOCKED).
- **공유 DEV의 "기존 데이터"(TEST_CENTER, TEST 계정) 변경은 일반 CI에서 여전히 발생한다 — 특히 7번의 기존 수업 삭제.**

## 4. 목표 구조 설계 (구현하지 않음)
- **A. 일반 CI(PR)**: unit, lint, tsc, build, PGlite SQL 회귀, 정적/모킹 테스트(jsdom), `--list`. DB 쓰기 0. → 현재 `unit/lint/build/sql/live-env-preflight`가 해당(변경 불필요).
- **B. 격리 통합 테스트**: 기존 integration + E2E 전체를 **일회성 독립 Supabase 프로젝트/브랜치 DB**에서 실행(테스트 계정·센터·상품을 seed로 새로 생성, 종료 시 프로젝트/브랜치 폐기). 공유 DEV·운영 접근 불가(secrets 분리, 호스트 allow-list 가드).
- **C. 실 DEV 관리자 E2E**: 수동(`npm run test:e2e:admin-pagination`, 커밋 1259354) — 기존 데이터 읽기 중심, 전제 미충족 시 BLOCKED.
- **전환 순서(제안)**: ① B 환경 확보 → ② `test.yml`의 live job을 B로 향하게 하거나 `workflow_dispatch` 전용으로 이동 → ③ PR 트리거에서 live job 제거 → ④ 그 전까지 현행 유지.

## 5. 이 환경에서 B를 구성할 수 없는 이유 (BLOCKED)
- `docker`·`psql` 없음 → `supabase start` 로컬 스택 불가(`supabase` CLI는 있으나 컨테이너 필요).
- 스키마는 `supabase/migrations` 1개 + 저장소 루트 SQL 약 440개로 흩어져 있어 "스키마 baseline"이 정의되어 있지 않다(`scripts/ci-dev/bootstrap.mjs`도 baseline을 자동 적용하지 않음). 신규 Supabase 프로젝트 생성·SQL 적용은 외부 반영이라 승인 필요.
- 따라서 구현하지 않았다. 필요한 승인 사항: 테스트 전용 Supabase 프로젝트(또는 Branching) 생성·비용, baseline 스키마 확정/적용, 새 secrets 등록.

## 6. 변경이 필요한 workflow (승인 후)
`test.yml`만 해당: (1) `pull_request` 트리거에서 live E2E/Integration 분리 또는 격리 DB secrets로 교체, (2) 격리 DB 생성/폐기 job, (3) 필요시 `workflow_dispatch` 전용 live job. 그 외 workflow 변경 없음. **이번 작업에서는 `test.yml`을 변경하지 않았다.**

## 7. 적용 상태 (workflow 차단, 2026-10-15)
- `test.yml`의 live job **7개**(`live-env-preflight`, `e2e-1-auth-attendance`, `e2e-2-admin-config`, `e2e-3-class-reservation-checkout`, `e2e-4-settings-readiness`, `integration`, `acl-fixture-repeat`)는 각자 `if`가 `false &&`로 시작한다. **pull_request·push·workflow_dispatch 어떤 이벤트에서도, 어떤 입력으로도 실행되지 않는다**(needs 사슬·ACK·`always()`에 의존하지 않음). ACK 입력은 제거했다 — 문구만으로는 아무것도 켜지지 않는다.
- 일반 PR/dispatch에서 계속 실행: `unit`, `lint`, `sql`(PGlite), `build`(placeholder env). DB·secrets 접근 없음.
- 정적 테스트 `tests/unit/ciSharedDevWriteGate.test.ts`가 live job 7개의 `if` 식을 이벤트·ACK·fork·브랜치·취소 여부·needs 결과의 768개 조합으로 평가해 true가 없음을 확인하고, 안전 job이 계속 실행됨을 확인한다. 차단을 일부러 제거하는 7가지 변형(false 제거 ×3, dispatch+ACK 대체, always() 우회, ACK 입력 재도입, 안전 job 게이트)에서 모두 실패함을 오프라인 복사본으로 확인했다.
- **재활성화**: 격리 DB 준비 후 `false &&`를 지우는 리뷰된 변경 + 위 테스트의 의도적 갱신. 그 전에는 Integration 53개·E2E 전체는 **일반 CI에서 실행되지 않으며 PASS로 보고되지 않는다(BLOCKED)**.
- **남은 한계**: workflow 밖의 경로 — 로컬에서 `.env.test.local`이 공유 DEV를 가리킨 채 `npm run test:integration`/`test:e2e`를 실행하면 §2의 쓰기가 그대로 발생한다(`productionGuard`는 Production만 차단). 테스트 코드와 helper(`deleteExistingClassesByTitle` 등)는 변경하지 않았다.

## 8. 격리 테스트 DB 전제 조건 (문서화만 — 생성하지 않음)
1. 공유 DEV·운영과 다른 Supabase 프로젝트(또는 Branching 브랜치). URL/키는 별도 secrets(`ISOLATED_*`)로만 주입, `productionGuard`의 알려진 Production ref 차단 + 격리 프로젝트 ref allow-list.
2. **스키마 baseline 확정**: 현재 `supabase/migrations` 1개 + 루트 SQL 약 440개(`add_*/fix_*/verify_*/cleanup_*`)로 적용 순서가 정의되어 있지 않다. 필요: (a) 현재 DEV 스키마 덤프를 baseline 마이그레이션으로 고정하거나 (b) 루트 SQL의 적용 순서 매니페스트 작성, (c) RLS·함수 권한(GRANT)·`delete_test_center_cascade` 등 RPC 포함 여부 검증, (d) 참조 카탈로그(`ci:dev:seed` 대상) 적재.
3. seed로 테스트 계정(USER_A/B, MANAGER_A/B, STAFF_A/B)·센터·상품을 **새로 생성**(공유 계정 재사용 금지). 플랫폼 관리자 계정도 격리 DB 안에서만 생성 → `test:integration:privileged`와 관리자 E2E를 여기서 자동 실행 가능.
4. job 종료 시 프로젝트/브랜치 폐기(또는 초기화)로 취소·timeout 잔여 문제 제거. 동시 실행 직렬화(concurrency) 유지.
5. 비용·권한: 프로젝트 생성 비용, GitHub Secrets 등록, Supabase 관리 토큰(자동 생성/폐기용)은 사용자 승인 필요.
