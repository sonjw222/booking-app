# CI/dev Supabase 프로젝트 준비 가이드

live CI(E2E/Integration)는 **Production이 아닌 전용 Supabase 프로젝트**에서만 돈다. Production guard(`tests/integration/productionGuard.ts`, `scripts/ci/liveEnvPreflight.mjs`)는 약화하지 않는다. 이 문서의 1~3은 사람이 한다(저장소 코드는 프로젝트를 만들지 않는다).

## 1. 프로젝트 생성 (사람)
1. Supabase Dashboard에서 새 프로젝트 생성(이름 예: `mwhabit-ci-dev`, Production과 다른 ref).
2. Auth 설정: Email 로그인 활성, "Confirm email"은 fixture를 `email_confirm: true`로 만들므로 영향 없음. 소셜 로그인/SMS는 불필요.
3. Settings → API에서 URL, anon key, service role key 확인(값은 채팅/Git에 붙이지 않는다).

## 2. DB 스키마 (사람, 주의)
- 루트 `*.sql` 파일명 순서는 **migration 순서가 아니다**. 새 프로젝트에 올바른 순서로 적용하는 방법은 `docs/CI_DEV_DATABASE_BOOTSTRAP_GAPS.md` 참고(재현성 공백 포함). Production의 현재 정의를 읽기 전용으로 확인하지 않은 채 오래된 `fix_*.sql`을 임의 재실행하지 않는다.
- 이 작업은 **dev 프로젝트에만** 한다. Production에는 SQL을 실행하지 않는다.

## 3. fixture 데이터
- 센터 1개 + 상품 1개 + 역할(오너/매니저/스태프) 행이 필요하다. 만든 뒤 id를 `TEST_CENTER_ID`, `TEST_PRODUCT_ID`로 기록.
- 인증 계정 6개(USER_A/B, MANAGER_A/B, STAFF_A/B): `CI_DEV_SEED_ACK=1 npm run ci:dev:seed`(비-production 가드 통과 시에만, 멱등).

## 4. 필수 GitHub Secrets 이름 (값은 새 프로젝트 기준으로 교체)
`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `TEST_CENTER_ID`, `TEST_PRODUCT_ID`, `TEST_{USER,MANAGER,STAFF}_{A,B}_{EMAIL,PASSWORD}`.
소비처: E2E 4개 잡 + Integration + `live-env-preflight`(`.github/workflows/test.yml`). Production service role key는 교체 후 회전 권장.

## 5. 검증 (로컬, dev 값으로만)
```
npm run ci:dev:preflight   # env만 검사: Production이면 중단, 필수 이름 누락 확인
npm run ci:dev:verify      # READ-ONLY: 센터/상품/fixture 계정 존재 확인
```
두 스크립트 모두 Production ref/키/URL이면 네트워크 호출 전에 exit 1.

## 6. 그 다음
Secrets 교체 → PR #170 CI 실행. `live-env-preflight`가 통과해야 E2E가 시작된다.
