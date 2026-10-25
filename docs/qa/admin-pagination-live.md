# 관리자 페이지네이션 DEV 검증 (읽기 전용 수동 실행)

**CI는 이 검증을 실행하지 않는다.** 이전 시도(PR #229)의 자동 fixture(관리자 권한 임시 승격, 상태별 31개씩 센터 93개 생성·삭제)는 DB 쓰기·권한 변경이라 제거했고, `tests/unit/adminPaginationCiSafety.test.ts`가 재유입을 정적으로 막는다.

## 전제 (없으면 BLOCKED — skip·기대값 완화 금지)
- DEV Supabase(Production은 `assertIntegrationTargetIsNotProduction`이 차단).
- DEV에 **이미 존재하는** 플랫폼 관리자 계정 `TEST_PLATFORM_ADMIN_EMAIL` / `TEST_PLATFORM_ADMIN_PASSWORD`(`.env.test.local`). 이 도구는 계정·권한을 만들거나 바꾸지 않는다.
- 승인대기·승인됨·반려됨 각각에 **기존** 센터 31건 이상(데이터를 만들지 않는다).
- ON 검증: DEV에 `admin_list_centers_page` RPC가 이미 적용되어 있어야 함(SQL 실행은 이 작업의 범위 밖, 사용자 승인 사항).

## 실행 (로컬, 사람이)
```
npm run test:e2e:admin-pagination
```
`scripts/e2e/adminPaginationReadonly.mjs`가 ON(`NEXT_PUBLIC_ADMIN_CENTER_PAGINATION=true`)과 OFF(`=false`)를 **서로 다른 env의 별도 dev 서버 프로세스**로 순차 실행한다. 이 모드(`RUN_ADMIN_PAGINATION=1`)에서는 `playwright.config.ts`가 `reuseExistingServer`를 끄므로 :3000에 다른 플래그 서버가 떠 있으면 재사용하지 않고 기동 실패한다. 사전 빌드는 필요 없다(webServer=`npm run dev`, NEXT_PUBLIC_*는 서버 시작 시 주입). 또한 첫 테스트가 화면의 실제 RPC 이름(ON=`admin_list_centers_page`, OFF=`admin_list_centers`)이 선언한 플래그와 일치하는지 검사한다.

로그인은 Supabase Auth 세션을 만든다(auth 내부 `last_sign_in_at` 등 갱신은 불가피). 업무 데이터 쓰기는 없다: 승인/반려 클릭 없음, 네트워크 오류 테스트는 요청을 abort만 한다.

SQL 필요: NO.

## 격리 환경 실행 (2026-10-25 추가 — 공유 DEV 불필요)
`tests/rls-real/adminPagination.ui.spec.ts`(+ `adminCenterPage.rls.test.ts`)가 격리 PostgreSQL/PostgREST 에서 플랫폼 관리자(격리 DB 안에서만 생성)로 ON/OFF 를 각각 검증한다. 상태별 데이터: 승인대기 31(30/31 경계, 같은 `created_at` 동률 5건 포함)·승인됨 30·반려됨 61(30+30+1).
```
tests/rls-real/run.sh up && PROXY_PORT=3211 POSTGREST_PORT=3203 node tests/ui-real/proxy.mjs &
NEXT_PUBLIC_ADMIN_CENTER_PAGINATION=true UI_RLS_PORT=3311 npx playwright test -c playwright.rlsui.config.ts tests/rls-real/adminPagination.ui.spec.ts --project=desktop-chromium   # ON
UI_RLS_PORT=3312 npx playwright test -c playwright.rlsui.config.ts tests/rls-real/adminPagination.ui.spec.ts --project=desktop-chromium                                       # OFF
```
이것은 **DEV Supabase 의 실브라우저 검증이 아니다**(Auth/Realtime 미대체). 실제 DEV 확인은 위 수동 러너의 전제(기존 플랫폼 관리자·상태별 31건 이상)가 갖춰졌을 때만 한다.
