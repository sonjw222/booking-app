# CI/dev Supabase 프로젝트 준비 가이드

live CI(E2E/Integration)는 **Production이 아닌 전용 Supabase 프로젝트**에서만 돈다. Production guard(`tests/integration/productionGuard.ts`, `scripts/ci/liveEnvPreflight.mjs`)는 약화하지 않는다.
**repo 쪽 준비는 끝났지만, dev 프로젝트는 아직 존재하지 않는다.** 사람이 해야 하는 일은 아래 ① 프로젝트 생성 ② 값 전달 ③ GitHub Secrets 교체 ④ merge 승인뿐이고, 나머지(스키마 적용 보조·fixture 생성·검증)는 Claude가 명령으로 한다.

## 사람이 하는 일 (순서)
1. Supabase Dashboard → New project (이름 예 `mwhabit-ci-dev`, **Production과 다른 ref**). 만든 뒤 Settings → API에서 Project URL, anon key, service role key, Settings → Database의 DB password를 확보(값은 채팅에 붙이지 말고 로컬 `.env.ci-dev.local` 같은 gitignored 파일이나 터미널 env로만).
2. 테스트 계정 이메일/비밀번호 4쌍(USER_A/B, MANAGER_A/B)을 정한다(예: `ci-user-a@example.com` + 임의 비밀번호). 실제 사용자 계정 재사용 금지.
3. (스키마 적용 단계에서) Production 스키마 **읽기 전용** 덤프를 Claude가 실행해도 된다고 승인.
4. GitHub → Settings → Secrets에 값 교체(아래 §4 이름표). `TEST_CENTER_ID`/`TEST_PRODUCT_ID`는 seed가 알려준다.
5. PR #170 CI 결과 확인 후 merge 승인.

## 자동화된 명령 (모두 비-production 가드 내장 — Production이면 네트워크 호출 전에 중단)
| 명령 | 하는 일 | 변경? |
|---|---|---|
| `npm run ci:dev:preflight` | env만 검사(Production 거부 + 필수 이름) | 없음 |
| `npm run ci:dev:verify` | 스키마(테이블/컬럼/RPC) + fixture 계정/센터/상품 검증. 출력 PASS/MISSING/MISMATCH/SKIP (`--schema` 인자: 스키마만) | **읽기 전용** |
| `npm run ci:dev:seed` | Auth 사용자 4 + accounts/profiles + fixture 센터 + 상품 생성(멱등). 끝에 `.tmp/ci-dev-secret-map.env`에 ID만 저장 | dev에만 쓰기 |
| `npm run ci:dev:secret-map` | seed 후 TEST_CENTER_ID/TEST_PRODUCT_ID 다시 출력 | 읽기 전용 |
| `npm run ci:dev:bootstrap` | preflight → 스키마 검증 → seed → 전체 검증. 스키마가 없으면 seed 전에 "schema baseline must be applied first"로 중단 | dev에만 쓰기 |

seed/bootstrap 실행 조건(셋 다 필요): ① URL/키가 Production 아님 ② `CI_DEV_TARGET_PROJECT_REF`가 URL의 project ref와 정확히 일치 ③ `CI_DEV_SEED_ACK=1`. 재실행해도 중복 생성 없음(고정 이름 marker: 센터 `CI Fixture Center (do not delete)`, 상품 `CI Fixture Pass 10`). 중간에 실패하면 다시 실행하면 이어서 진행하며, 자동 삭제/정리는 하지 않는다.

## 자동으로 만들어지는 것 vs 테스트가 스스로 만드는 것 (코드 기준)
- seed가 만든다: Auth 사용자 4(USER_A/B, MANAGER_A/B; 이메일 확인 완료), `accounts`(is_manager는 매니저/스태프만), 대표 `profiles`, **TEST_CENTER_ID 센터(approved)**, **TEST_PRODUCT_ID 상품(pass, 10회, 10,000원, 판매중)**.
- 테스트가 직접 만들고 정리한다(fixture 불필요): 매니저 소유 센터(`getOrCreateOwnedTestCenter` → `통합테스트센터-*`와 오너 역할/`manager_centers` 연결), 스태프 초대/역할/권한 오버라이드, 수업·예약·수강권·주문·결제, center_settings 초기화. 그래서 매니저/스태프 연결과 `center_settings`는 seed에서 만들지 않는다.
- 사람 작업으로 남지 않는 것: 센터·상품·역할 수동 생성.

## 스키마 (Claude가 단계별 실행 — 상세: `docs/CI_DEV_DATABASE_BOOTSTRAP_GAPS.md`)
루트 SQL 439개를 직접 실행하지 않는다. 확정 절차는 gaps 문서의 "확정 bootstrap 절차" 참고(Production 스키마-only 읽기 덤프 → dev에만 적용 → verify).

## 필수 GitHub Secrets 이름 (값은 dev 프로젝트 기준)
`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `TEST_CENTER_ID`, `TEST_PRODUCT_ID`, `TEST_{USER,MANAGER}_{A,B}_{EMAIL,PASSWORD}` (총 13개). `TEST_STAFF_A/B_*`는 어떤 테스트도 읽지 않아 불필요(workflow가 env로 넘기기만 함 — 없어도 됨). 소비처: `.github/workflows/test.yml`의 E2E 4개 잡 + Integration + `live-env-preflight`. `mobile-ui-qa.yml`은 Production 웹앱을 여는 별도 수동 QA라 이 Secrets 교체와 무관하다(ACK 필수).
교체 후 Production service role key는 사용처가 사라지므로 회전 여부는 `docs/CI_PRODUCTION_EXPOSURE_AUDIT_20261007.md`의 판단 참고.

## 로컬 실행 예 (dev 값만; 값은 터미널 env로, 파일은 gitignored)
```
export NEXT_PUBLIC_SUPABASE_URL=https://<dev-ref>.supabase.co CI_DEV_TARGET_PROJECT_REF=<dev-ref> CI_DEV_SEED_ACK=1 ...
npm run ci:dev:bootstrap
```
