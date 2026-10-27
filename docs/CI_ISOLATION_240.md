# #240 CI 격리 이전 — 현황·준비·남은 외부 항목 (2026-10-26)

**상태: 전환 미완료(BLOCKED — 외부 격리 Supabase 환경 없음).** 이 문서는 확인된 사실과 repo 쪽에서 끝낸 준비, 그리고 사람이 준비해야 하는 항목을 구분한다. #240 은 실제 전환(격리 환경에서 필수 E2E/Integration 실행 + 공유 DEV 쓰기 0) 전에는 닫지 않는다.

## 1. 지금 PR push 가 하는 일 (확인됨)
- `.github/workflows/test.yml` 은 `pull_request`(같은 저장소 head, fork 제외)에서 `live-env-preflight` 통과 후 **공유 DEV(`mwhabit-ci-dev`, ref `jdglfvwdnkjnraqdxuuj`)** 에 service role 로 접속하는 live job 5개를 순차 실행한다. `push` 는 main 만, 그때는 비-live job(unit/sql/lint/build)만 돈다. 저장소 전역 concurrency `shared-live-supabase-tests`(cancel-in-progress false).
- 취소된 live 실행은 공유 DEV 에 잔여를 남길 수 있다(실제 사례: 이전 실행이 만든 같은 제목 수업이 다음 실행의 strict mode 위반을 일으킴).

## 2. CI job 목록 — 대상·권한·쓰기·정리
| job | 대상 | 자격 증명 | 쓰는 것 | 정리 | 권한/전역 설정 변경 |
|---|---|---|---|---|---|
| live-env-preflight | 없음(env 검사) | 시크릿 값을 검사만 | 없음 | — | 없음 |
| e2e-1 auth+attendance | 공유 DEV | service role + USER_A/B·MANAGER_A/B·STAFF_A/B 로그인 + TEST_CENTER_ID/PRODUCT_ID | 수업·예약·수강권·상품·결제, 로그인 세션 | 테스트별 cleanup(수업은 Q01 소유 증명 정리, 상품은 #231/#234 실행 소유 정리), 일부 fixture 는 공유 계정에 영속 | 일부 스펙이 센터 설정(center_settings) 저장 |
| e2e-2 admin-config | 공유 DEV | 동일 | 허용 상품·휴무일·예약 조건·반복 수업·센터 설정 | 동일 | 센터 설정 변경(공유 센터 A) |
| e2e-3 class/reservation/checkout | 공유 DEV | 동일 | 새 수업·예약·mock 결제 | 동일 | 센터 설정 |
| e2e-4 settings/readiness | 공유 DEV(+ dev Edge Functions 3개) | 동일 | 예약 설정·생애주기(회원 가입/탈퇴 포함) | 동일 | 센터 설정, Auth 사용자 생성/삭제 |
| integration | 공유 DEV | 동일(service role 포함) | 53개 파일: 수업·예약·수강권·주문·결제·알림 | 파일별 afterAll/afterEach(id 기반) | 계정 프로모션/전역 기본 요금제 변경 테스트는 일반 CI 에서 제외(`test:integration:privileged` 수동 스위트) |
| acl-fixture-repeat | 공유 DEV | 동일 | 특정 브랜치 전용 | — | 조건부(`github.head_ref == 'test/acl-fixture-restore-20261012'`) |
| sql | 로컬 PGlite | 없음 | 없음 | — | 없음 |
| unit / lint / build | 없음(placeholder env) | 없음 | 없음 | — | 없음 |
| **isolated-env-gate (신규)** | 없음(env 검사; GitHub checkout/setup-node 는 실행, Supabase API·DB 호출 없음) | `ISOLATED_*` 시크릿만(공유 DEV 비밀 사용 금지 — contract test 로 고정) | 없음 | — | 없음 |
- 별도 워크플로: `admin-pagination.yml`(오프라인 SQL), `dev-agent.yml`(실행 안 함), `mobile-ui-qa.yml`(수동·ACK 필요, TEST_* 시크릿 사용 — Production QA 용도, 이번 범위 밖).

## 3. 이미 있는 환경 (값은 기록하지 않음)
| 항목 | 존재 | 용도 | 격리 대상으로 사용 가능? |
|---|---|---|---|
| Supabase `mwhabit-ci-dev` (`jdglfv…`) | 있음 | 현재 공유 DEV(live CI 대상) | **아니오** — 정의상 공유 DEV(가드가 격리 선언을 거부) |
| Supabase Production (`bxntqg…`) | 있음 | 운영 | **절대 아님** |
| Supabase branches (`supabase branches list`, 공유 DEV 기준) | 없음(빈 목록) | — | 해당 없음 |
| GitHub Environments | `Preview`, `Production` 만 | Vercel 배포 | 격리 DB 용 아님 |
| GitHub Secrets | 공유 DEV 용 13개 이름(`NEXT_PUBLIC_SUPABASE_*`, `SUPABASE_SERVICE_ROLE_KEY`, `TEST_*`) | 공유 DEV | `ISOLATED_*` 이름은 **없음** |
| 로컬 Docker PostgreSQL 16 + PostgREST (`tests/rls-real/run.sh up`) | 있음(로컬 전용) | RLS·SQL·UI 회귀 | **부분 대체만**(아래) |

## 4. 로컬 대체가 덮는 것 / 못 덮는 것
- 덮음: 스키마(루트 SQL 일부)·RLS·RPC·PostgREST 질의, 실제 JWT 로 브라우저 UI(격리 프록시), Q01 소유 정리의 삭제·실패 주입·병렬 회귀(23건), 시각 스윕.
- **못 덮음**: Supabase **Auth**(live E2E/Integration 의 로그인·세션·`auth.admin` 사용자 생성/삭제 — 해당 파일 11개), **Storage**(버킷), **Realtime**, **Edge Functions**(phone OTP·이메일 중복 확인·계정 삭제, E2E 4/4 `member-full-lifecycle`). 또 격리 DB 는 운영 스키마 일부만 적용(관리자 6개 경로가 오류 화면, `docs/TODO.md` Q02 후속).
- 따라서 **로컬에서 일부가 통과해도 "전체 Supabase 통합 검증"으로 보고하지 않는다.** 가드는 로컬 URL 을 `PARTIAL` 로 판정해 전체 게이트를 통과시키지 않는다.

## 5. repo 쪽에서 끝낸 준비
1. **격리 대상 가드** `scripts/ci/isolatedTargetGuard.mjs`(단위 + 실제 CLI 종료 코드 회귀): 어떤 쓰기보다 먼저 env 만 검사한다(Supabase API·DB 호출 코드 없음). **입력된 값의 위험·오류를 누락 검사보다 먼저** 평가한다 —
   - FAILED: Production·공유 DEV(고정 ref + CI 의 `NEXT_PUBLIC_SUPABASE_URL`) 대상, 잘못된 URL(정상적인 `https://<20자 ref>.supabase.co` 기본 주소만 허용: HTTP·사용자정보·포트·루트 외 경로·쿼리·fragment·공백 거부), JWT 아닌 키, URL·선언 ref·키 ref 불일치 — **다른 필수값이 없어도** FAILED.
   - BLOCKED: 위험은 없는데 설정이 전부 없거나 안전한 값만 일부 있음.
   - PARTIAL: 로컬 대체 URL(별도 처리 유지; Auth/Storage/Realtime/Edge 없음 — 전체 통합 검증으로 보고 금지).
   - OK: 안전한 값이 모두 갖춰짐. 비밀 값은 출력하지 않는다.
2. **CI 게이트 job `isolated-env-gate`**: GitHub 의 `actions/checkout`·`setup-node` 는 실행하지만 **Supabase API·DB 를 호출하지 않는다**(공유 DEV 비밀도 읽지 않음 — contract test 로 고정). `ISOLATED_*` 가 없으면 Step Summary 에 **BLOCKED** 를 남기고 warning 과 함께 통과로 표시된다 — **이 통과는 격리 전환 완료도 live 검증 통과도 아니다.** `ISOLATED_GATE_ALLOW_BLOCKED=1` 은 BLOCKED 에만 적용되고, **FAILED 는 항상 실패 종료**, PARTIAL 은 종료 3.
3. 기존 live 검증은 **끄지 않았다**(`false &&`·skip 전환 없음). Q01(수업 소유 정리, #241 병합)·#231/#234(상품 소유 정리)로 live 잔여 위험을 줄였으나 격리 이전을 대체하지 않는다.

## 6. 전환 완료의 증거 (모두 필요)
1. 격리 환경에서 필수 E2E 4구간 + Integration 이 **실제로 실행**되고 의도치 않은 skip 0 (조건부 skip 과 환경 부재 skip 을 구분해 보고).
2. 운영/공유 DEV 로의 쓰기 0 (가드가 OK 일 때만 실행; 가드는 Supabase 호출·쓰기 전에 env 만 보고 차단).
3. 자체 fixture(계정·권한·센터·상품) 생성과 실행 소유 정리 확인, 실패·취소 후 복구 확인. 공유 계정 프로모션·전역 기본 요금제 변경 재도입 금지.
4. 현재 필수 체크와 격리 job 결과를 같은 PR 에서 비교한 뒤에만 전환.

## 7. 사람이 준비해야 하는 항목 (한 번에)
1. **격리 Supabase 프로젝트 1개**(Production·`mwhabit-ci-dev` 와 다른 ref) 또는 Supabase branch(플랜 지원 확인). 공유 DEV 를 재사용하지 말 것.
2. **스키마 baseline**: `docs/CI_DEV_DATABASE_BOOTSTRAP_GAPS.md` 절차(Production 스키마-only 읽기 덤프 → 격리 프로젝트에만 적용 → `ci:dev:verify`). Auth: Email ON·Confirm email OFF·rate limit 상향. Edge Functions 3개 배포 + `PHONE_OTP_TEST_BYPASS_PREFIX`.
3. **GitHub 등록 위치**: Repository Settings → Secrets and variables → Actions → Secrets(또는 전용 Environment `isolated`)에 `ISOLATED_SUPABASE_URL`, `ISOLATED_SUPABASE_PROJECT_REF`, `ISOLATED_SUPABASE_ANON_KEY`, `ISOLATED_SUPABASE_SERVICE_ROLE_KEY` + 격리 프로젝트 전용 테스트 계정/센터/상품 값(이름은 `ISOLATED_TEST_*` 로 분리해 공유 DEV 값과 섞지 않는다). 값은 채팅/커밋에 남기지 않는다.
4. 위가 갖춰지면 후속 PR 에서 live job 의 시크릿을 `ISOLATED_*` 로 전환(가드 `OK` 선행 조건), 그 PR 의 CI 결과를 현재 체크와 비교.
