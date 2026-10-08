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
- seed가 만든다: Auth 사용자 4(USER_A/B, MANAGER_A/B; 이메일 확인 완료), `accounts`(is_manager는 매니저/스태프만), 대표 `profiles`, **TEST_CENTER_ID 센터(approved + `is_internal=true`)**와 USER_A/B의 `center_members`, **TEST_PRODUCT_ID 상품(pass, 10회, 10,000원, 판매중)**.
- 테스트가 직접 만들고 정리한다(fixture 불필요): 매니저 소유 센터(`getOrCreateOwnedTestCenter` → `통합테스트센터-*`와 오너 역할/`manager_centers` 연결), 스태프 초대/역할/권한 오버라이드, 수업·예약·수강권·주문·결제, center_settings 초기화. 그래서 매니저/스태프 연결과 `center_settings`는 seed에서 만들지 않는다.
- 사람 작업으로 남지 않는 것: 센터·상품·역할 수동 생성.

## dev 프로젝트 필수 설정 (테스트 코드 근거 — Dashboard에서 사람이 한 번 확인)
dev 프로젝트: `mwhabit-ci-dev`, ref `jdglfvwdnkjnraqdxuuj`(ap-northeast-1; CLI `projects list`로 확인, Production `bxntqggkfwnhcczsbqtj`와 다름).
1. **Authentication → Sign In / Providers → Email**: Email provider ON, **"Confirm email" OFF**, "Allow new users to sign up" ON. 근거: `tests/integration/auth-account-bootstrap.test.ts`(throwaway signUp)와 `tests/e2e/production-readiness/member-full-lifecycle.spec.ts`(신규 이메일 가입 후 즉시 세션)가 가입 직후 세션을 기대한다. 소셜 provider(Google/Kakao/Naver/Apple), SMS provider, redirect URL은 테스트가 쓰지 않아 불필요.
2. **Edge Functions (E2E 4/4의 `member-full-lifecycle`만 필요)**: `send-phone-otp`, `check-signup-email`, `delete-account`를 dev 프로젝트에 배포하고 Supabase secret `PHONE_OTP_TEST_BYPASS_PREFIX=0100000`(테스트가 쓰는 번호 접두사)을 dev에만 등록한다. 이 secret은 Production에는 등록하지 않는다(함수 주석: CI/QA 전용). Aligo 등 실제 발송 키는 불필요(bypass 번호는 발송 없이 코드 반환).
3. DB 설정: 스키마 적용 단계에서 처리(아래).

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

## dev 구축 기록 (2026-10-07, `mwhabit-ci-dev` / ref `jdglfvwdnkjnraqdxuuj`)
- 스키마: Production **public 스키마-only** 덤프(`pg_dump --schema-only --no-owner --schema=public`, `schemaDumpCheck` 통과) → dev에만 적용. 덤프의 `CREATE SCHEMA public;`은 Supabase 기본 public과 충돌하므로 적용본에서 그 한 줄만 주석 처리. 테이블 91/91, 함수 169/169, RLS 정책 200/200 일치.
- 이 저장소 워크트리의 CLI link는 Production을 가리킬 수 있다 → dev 명령은 항상 `--project-ref jdglfvwdnkjnraqdxuuj`(또는 `--db-url`)만 사용, `--linked` 금지, `supabase link` 변경 금지.
- Edge Functions 3개(`send-phone-otp`, `check-signup-email`, `delete-account`)는 `supabase functions deploy <name> --project-ref <dev> --use-api`로 dev에만 배포(Docker 불필요). dev 전용 secret `PHONE_OTP_TEST_BYPASS_PREFIX=0100000`(`supabase secrets set ... --project-ref <dev>`).
- 로컬 dev 값 파일(모두 gitignored `.tmp/`, 권한 600, **출력 금지**): `ci-dev-keys.env`(URL/anon/service role — `supabase projects api-keys --project-ref <dev> --reveal`로 받아 JWT ref가 dev인지 확인 후 저장), `ci-dev-accounts.env`(테스트 계정 4쌍 + `CI_DEV_TARGET_PROJECT_REF`), `ci-dev-secret-map.env`(ID만). 사용: `set -a; . .tmp/ci-dev-keys.env; . .tmp/ci-dev-accounts.env; set +a; CI_DEV_SEED_ACK=1 npm run ci:dev:seed`.
- Auth 상태 확인법(읽기 전용, Dashboard 불필요): `GET <dev>/auth/v1/settings`의 `mailer_autoconfirm`(true여야 Confirm email OFF), `disable_signup`(false여야 함).
- `storage.from("avatars")`는 테이블이 아니라 버킷: `ci:dev:verify`가 버킷을 별도 검사한다(버킷/`storage.objects` 정책은 public 덤프에 없음 → Production 구성 읽기 필요).

### 첫 dev 통합 테스트 dry-run에서 확인된 dev 요구사항 (2026-10-07)
- **fixture 센터는 `is_internal=true` 여야 한다**: `confirm_test_payment`(mock 결제)가 내부 QA 센터에서만 허용된다("테스트 결제는 내부 QA 센터에서만 사용할 수 있어요"). internal 센터는 멤버/관리자에게만 보이므로 seed가 USER_A/B를 `center_members`로 등록한다(테스트가 USER_A로 상품을 먼저 읽는다). seed가 기존 센터도 보정한다.
- **Auth Rate Limits(Dashboard)**: 통합 테스트 53개 파일이 계정마다 반복 로그인해 기본 한도(sign-ups/sign-ins 5분당 30회/IP)에서 "Request rate limit reached"로 대량 실패한다(그 뒤 signUp 폴백이 "User already registered"로 이어짐). dev 프로젝트의 Authentication → Rate Limits에서 sign-ups/sign-ins 한도를 크게 올려야 한다.
- 권한 parity: dev는 신규 프로젝트 기본 권한 때문에 service_role=ALL, anon/authenticated에 REFERENCES/TRIGGER/TRUNCATE/MAINTAIN이 일부 테이블에 더 있다(DDL은 Production과 동일). `.tmp/dev-apply-storage-and-privileges.sql`(dev 전용, dev에만 있는 fixture 센터가 없으면 중단하는 안전장치 포함)이 Production 값으로 맞춘다.

### Auth 호출 정상화 (2026-10-07) — 429의 실제 원인과 해결
- 429 endpoint: `POST /auth/v1/token?grant_type=password`, 응답 `{"code":429,"error_code":"over_request_rate_limit","msg":"Request rate limit reached"}`. Dashboard의 sign-ups/sign-ins 한도(1000/5분)와 별개로 token endpoint에는 자체 한도(기본 150/5분 refill, burst ≈30)가 있어, 순차 실행(`fileParallelism:false`)인데도 스위트 하나가 4~5분 안에 password 로그인을 ~250회 보내 한도를 넘었다.
- 원인(측정, 전 스위트 1회): password 로그인 시도 251회(성공 154 + 429 97), 서버 logout 135회, 실패 후 signUp 폴백 85회. `switchToTestUser`가 호출(257곳)마다 `signOut({scope:'local'})`(서버 session 폐기) + `signInWithPassword`를 했다.
- 수정(`tests/integration/setup.ts`): 테스트 계정 세션을 OS 임시 폴더(0600, project ref별)에 캐시해 파일 간 재사용 → 유효하면 `setSession`(/token 호출 없음), 아니면 그때만 password 로그인. 로그인 전 서버 logout 제거(공유 세션을 죽이지 않음), `signOutTestSession`은 로컬 세션만 제거, 429면 signUp 폴백 없이 명확한 오류. 실제 사용자 JWT를 그대로 쓰므로 authenticated/anon 경계(RLS) 검증은 그대로다.
- 결과(같은 스위트): password 로그인 251→36, 429 97→0, logout 135→2, signUp 폴백 85→0. (`setSession` 검증용 `GET /auth/v1/user`가 ~650회 늘었지만 별도 제한 대상이 아니다.)

### Production 구성 데이터(카탈로그) 의존성 — schema-only 덤프에 없는 것
`permissions`(권한 키 목록), `subscription_plans`(기본 요금제) 등은 스키마가 아니라 **참조 데이터**라 새 DB에서 비어 있다. `permissions`가 비면 `account_center_permissions/role_permissions` FK 위반, `subscription_plans`가 비면 센터 생성 시 기본 구독이 안 만들어지고 `subscription-plan-limits`가 "기존 기본 플랜을 찾지 못했어요"로 실패한다. 이 참조 데이터는 Production에서 읽기 전용으로 가져와(사용자 데이터 아님) dev에만 넣는다.
