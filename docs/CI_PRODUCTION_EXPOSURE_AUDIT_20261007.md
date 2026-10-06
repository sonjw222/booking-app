# CI ↔ Production Supabase 노출 감사 (2026-10-07)

> 이 문서는 사실과 증거 수준만 기록한다. 비밀값은 포함하지 않는다. "Production 데이터 유출", "service role key 유출"을 뒷받침하는 증거는 **발견되지 않았다**(아래 §5). 과장하지 말 것.

## 1. 발견 경위
- PR #170의 Production guard가 live 잡에서 발동 → GitHub Actions Secrets(`NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` 등)가 **Production 프로젝트(ref `bxntqggkfwnhcczsbqtj`)** 를 가리키고 있음이 확인됨. 별도 CI/dev Supabase 프로젝트는 아직 없음.

## 2. 증거 수준 정의
CONFIRMED(로그/API로 직접 확인) · HIGHLY LIKELY(코드·시크릿 구성상 거의 확실, 직접 증거 없음) · POSSIBLE(조건부) · NO EXECUTION(실행 안 됨).

## 3. 과거 실행 타임라인 (gh read-only 조회)
- 조회한 workflow run 760건, live 단계(E2E/Integration)가 실제 실행된 run 591건, 가장 이른 시점 2026-07-30.
- 해당 run들이 **어느 프로젝트에 붙었는지**는 Secrets 값이 Production이었다는 현재 사실 + 그 값이 언제 설정됐는지 이력이 없다는 점에서 **HIGHLY LIKELY**(Secrets 변경 이력은 조회 불가). 개별 run 로그에 URL이 마스킹되어 CONFIRMED 불가.
- PR #170 이전에는 Production guard가 없었으므로 live 테스트는 가드 없이 실행되었다.

## 4. Production에 닿았을 수 있는 테스트와 흔적(fixture)
- Integration(service role 사용)과 E2E(Playwright)가 센터/계정/상품/수강권/수업/예약/주문/결제/센터 설정 데이터를 생성·변경한다. 접두사: `qa-*@example.com` 계정, 테스트 센터/상품/수업명 등(코드가 만드는 이름만 진단 대상).
- 이전 세션에서 수동 정리한 ID는 다시 삭제하지 않는다.
- 잔여 확인은 READ-ONLY 진단 SQL 6개를 **순서대로 한 번에 하나씩** 사용자가 실행: `diagnostics/ci_production_residue/diagnose_ci_residue_01_centers.sql` → `02_accounts_profiles` → `03_products_memberships` → `04_classes_reservations` → `05_orders_payments` → `06_settings`. 모두 SELECT 전용이며 정리/삭제 SQL은 이 감사 범위에 없다. 결과를 보고 정리 여부는 별도 결정.

## 5. 비밀/토큰 노출 감사 — 판정: NO EVIDENCE (POTENTIAL 요소 있음)
- 로그: GitHub가 Secrets를 마스킹하며, 진단 reporter는 JWT 및 PASSWORD/KEY/SECRET/TOKEN/EMAIL/AUTHORIZATION env 값을 redaction. 로그에서 값이 노출된 증거 없음.
- 아티팩트: 현재 보존 중인 아티팩트 없음(조회 시점). 다만 저장소가 **PUBLIC**이고 Playwright report/trace/test-results는 요청 URL·이메일 등을 담을 수 있으므로 **POTENTIAL**. 완화: retention 14일→3일(#170).
- `playwright/.auth/`(storageState)는 gitignore. 아티팩트 경로는 `playwright-report/`, `test-results/`로 한정(계약 테스트로 고정).
- 권고(수행 안 함): 새 dev 프로젝트로 Secrets 교체 시 Production service role key를 **회전**하는 것을 검토(증거는 없지만 비용이 낮은 예방 조치). 회전은 사용자가 직접.

## 5-1. 과거 artifact 점검 (2026-10-07 후속, 읽기 전용 metadata 조회)
- `GET /repos/.../actions/artifacts` 결과: **artifact 0건**(만료된 것 포함). 즉 삭제할 artifact 없음. 저장소 기본 보존기간 설정은 90일이며, workflow가 `retention-days`를 명시해 이를 덮어쓴다(과거 14일, 현재 3일 — #170).
- workflow 이력(`test.yml` 39개 revision 전수): artifact `path`는 **항상 `playwright-report/`와 `test-results/` 두 개뿐**이었고 `playwright/.auth/`(storageState)는 포함된 적이 없다. `.gitignore`는 E2E 도입 커밋(94e81c7)부터 `playwright/.auth/`를 제외한다. 저장소에 추적된 `.auth` 파일 0개.
- 판정: 과거 artifact로 인한 노출 **NO EVIDENCE**(보존된 것이 없음). 메커니즘상 `trace: retain-on-failure`는 네트워크 요청(로그인 요청 본문, 헤더)을 담을 수 있어 **향후** artifact는 POTENTIAL이다 → dev 프로젝트로 교체한 뒤에는 대상이 테스트 전용 계정/키라 영향이 작다. `mobile-ui-qa.yml`의 artifact(`android-ui-test-results`, `ios-ui-test-results`)도 0건, 보존 3일로 단축.
- 삭제 권고 artifact: 없음. (GitHub mutation은 이번에도 수행하지 않음.)

## 5-2. service role key 회전 판단: **OPTIONAL** (증거 기반)
- 근거(노출 가능성을 낮추는 사실): 협업자가 소유자 1명뿐(`collaborators` 조회), `pull_request_target` 없음·fork PR에는 Secrets 미주입, artifact 0건, 로그는 GitHub 마스킹 + 리포터 redaction, 비밀 출력 증거 없음.
- 근거(위험을 키우는 사실): 저장소 PUBLIC, 이 키가 2개월 넘게 CI에서 사용됨, 과거에는 Production guard가 없었음(키가 테스트 코드에 쓰임).
- 판단: 노출 증거가 없으므로 REQUIRED/RECOMMENDED가 아니다. **다만** 회전은 Production 서버 라우트(`/api/*`가 같은 service role key를 쓴다면)·Vercel 환경변수를 동시에 바꿔야 해 운영 위험이 있다. 권고: 협업자 추가, 로그/artifact 노출 증거 발견, 또는 정기 보안 점검 시점에 맞춰 사용자가 Vercel 환경변수 갱신 절차와 함께 수행. 실제 회전은 하지 않았다.

## 6. 저장소 측 하드닝 (PR #170, 미병합)
Production guard(integration/E2E), `live-env-preflight` 잡, `permissions: contents: read`, 외부 action은 `actions/*`만, `pull_request_target` 없음, 아티팩트 보존 3일. `mobile-ui-qa.yml`은 수동(workflow_dispatch) 전용이며 live preflight가 없다 → TODO.

## 7. 남은 사람 작업
1. 별도 비-production Supabase 프로젝트 생성 → bootstrap/seed → GitHub Secrets 교체 → CI 실행.
2. 진단 SQL 6개를 순서대로 실행해 잔여 데이터 확인.
3. (선택) Production service role key 회전, main 브랜치 보호 규칙 설정(현재 없음).
