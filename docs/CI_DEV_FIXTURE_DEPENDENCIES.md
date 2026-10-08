# CI fixture 의존성 맵 (2026-10-07, 실제 코드 기준)

근거: `tests/integration/setup.ts`, `tests/e2e/auth.setup.ts`, `tests/integration/loadEnv.ts`, grep 결과(integration/e2e 파일 수).

## TEST_* 변수 사용처
| 변수 | integration 파일 수 | e2e 파일 수 | 비고 |
|---|---|---|---|
| `TEST_USER_A_EMAIL/PASSWORD` | 25 | 6 | 일반 회원. `switchToTestUser`가 get-or-create |
| `TEST_USER_B_*` | 12 | 2 | 두 번째 회원("본인 소유" 검증) |
| `TEST_MANAGER_A_*` | 36 | 2 | 센터A 오너. 테스트가 `getOrCreateOwnedTestCenter`로 자기 센터를 만든다 |
| `TEST_MANAGER_B_*` | 19 | 0 | 센터B 오너("다른 센터 차단" 검증) |
| `TEST_STAFF_A/B_*` | 0 | 0 | **어떤 테스트도 읽지 않음**(acl-003 주석: 전용 스태프 없이 MANAGER_A/B 사용). workflow가 env로 넘기기만 함 → 불필요 |
| `TEST_CENTER_ID` | 13개 파일 | – | 이미 존재하는 센터(주문/수강권/포인트 대상) |
| `TEST_PRODUCT_ID` | 10개 파일 | – | 그 센터의 상품(`id,name,price`로 읽음; 주문 금액 검증) |
| 인프라 env | `NEXT_PUBLIC_SUPABASE_URL/ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`(`getFixtureAdminClient`: RLS 우회 fixture/정리) | | + `NEXT_PUBLIC_PAYMENT_PROVIDER=mock` |

## 의존 그래프
```
Auth user (email_confirm=true, 비밀번호)  ←  signUp이 막히면 테스트 실패(Confirm email ON이면 즉시 로그인 불가)
  └─ accounts (auth_id, name, is_member)           ← 없으면 switchToTestUser가 insert
       └─ profiles (account_id, is_primary=true)   ← 없으면 insert
TEST_CENTER_ID  centers(status=approved)           ← seed가 만든다(marker 이름)
  └─ TEST_PRODUCT_ID products(center_id, pass, price>0, is_on_sale, is_active)  ← seed가 만든다
MANAGER_A/B → manager_centers → center_roles(is_owner)   ← 테스트가 getOrCreateOwnedTestCenter로 생성(오너 역할은 centers insert 트리거가 자동 생성)
STAFF/권한 override/수업/예약/수강권/주문/결제/center_settings ← 각 테스트가 만들고 afterAll에서 정리(또는 stale sweep)
```
DB 선행 조건(코드/seed가 만들지 않음): 전체 스키마·RLS·RPC·트리거(특히 `centers` insert 시 owner `center_roles` 자동 생성), `subscription_plans` 기본 행(센터 생성/플랜 한도 테스트), Auth 설정(이메일/비밀번호 가입 허용).

## seed 결정
- 만든다: Auth 4 + accounts/profiles 4, 센터 1(approved, **owner 연결 없음**), 상품 1.
- 만들지 않는다: `manager_centers`/staff/member 연결(테스트가 자체 생성·정리 — 선생성하면 `getOrCreateOwnedTestCenter`/`fetchMyCenters` 결과가 달라질 수 있음), `center_settings`(테스트가 stale reset), 기본 membership(테스트가 `createTestMembership`).
- 센터는 `is_internal`로 숨기지 않는다(비-멤버 USER_A가 상품을 읽어야 해서; internal이면 RLS가 막는다).
- 가정(첫 dev CI 실행에서 확인): TEST_CENTER 센터에 오너가 없어도 주문/수강권 흐름이 통과한다. 실패 시 verify는 PASS여도 CI가 알려주므로 seed를 확장(오너 연결)하면 된다.

## fixture 누수 점검 (Phase 12)
- 정리 훅(afterAll/afterEach)이 없는 integration 파일은 `sync-test-payment-center-member.test.ts` 1개였고 `afterAll(signOutTestSession)`을 추가했다(형제 파일과 동일: 세션만 정리, 주문/수강권/center_members는 공유 fixture 소유라 삭제하지 않음).
- 그 외 파일은 정리 훅이 있으나 훅 내용의 완전성(예: 특정 테이블 누락)은 정적으로 검증하지 않았다 → 첫 dev CI 후 `diagnostics`성 SELECT로 잔여 확인 권장.
