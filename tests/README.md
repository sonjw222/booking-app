# 테스트

이 프로젝트는 두 계층의 자동 테스트를 제공합니다. **UI/UX(예약·결제 화면 조작, 토스트, 화면 전환)는
사람이 직접 확인하는 영역이며 자동화 대상이 아닙니다.** 자동화된 것은 결제 시스템의 RPC/RLS/DB
정합성 같은 "시스템 레벨" 검증입니다.

## 실행 명령

| 명령 | 대상 | 실제 Supabase 필요? |
|---|---|---|
| `npm run test` | `tests/unit/` | ❌ 불필요 |
| `npm run test:integration` | `tests/integration/` | ✅ 필요 (개발용 Supabase) |
| `npm run test:all` | 위 둘을 순서대로 | ✅ (integration 단계에서) |

## 단위 테스트 (`tests/unit/`)

`lib/payments/mockPaymentApi.ts`(실제 RPC 호출부)를 `vi.mock()`으로 대체해 네트워크 호출 없이
`MockPaymentProvider`의 시나리오 분기(success/failed/cancelled)와 `PaymentProviderFactory`의
provider 선택 로직만 검증합니다. 아무 설정 없이 바로 실행됩니다.

## 통합 테스트 (`tests/integration/`)

`lib/orders.ts`/`lib/payments`의 **실제 함수**를 실제 개발용 Supabase 프로젝트에 대해 실행해,
`confirm_test_payment`/`cancel_test_payment` RPC의 실제 동작(권한, idempotency, DB 상태 변화)을
검증합니다.

> **기술 부채(TODO)**: `lib/orders.ts`를 직접 import해서 쓰므로, 그 파일을 리팩터링하면 이
> 테스트들도 함께 영향을 받을 수 있습니다. 지금은 실제 checkout 흐름을 그대로 검증한다는
> 장점이 있어 의도적으로 이렇게 뒀습니다 — 향후 분리 여부는 `docs/TODO.md`의 **P2-8** 참고.

### 필요한 환경변수

로컬에서는 `.env.test.local.example`을 복사해 `.env.test.local`을 만들고 채우세요
(`.gitignore`의 `.env*` 규칙에 포함되어 커밋되지 않습니다). CI(GitHub Actions)에서는 동일한
이름으로 **Repository Secrets**에 등록하면 `.github/workflows/test.yml`이 그대로 주입합니다.

| 변수 | 용도 |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | 테스트가 접속할 Supabase 프로젝트 URL. **반드시 개발용 프로젝트**여야 합니다(아래 "운영 DB 보호" 참고). |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | 위 프로젝트의 anon key. |
| `TEST_USER_A_EMAIL` / `TEST_USER_A_PASSWORD` | 통합 테스트 전용 계정 A. **get-or-create** 방식 — 로그인 시도 → 실패하면 자동 가입 → `accounts`/`profiles` 행이 없으면 그때 생성. 두 번째 실행부터는 그대로 재사용되어 계정이 계속 늘어나지 않습니다. |
| `TEST_USER_B_EMAIL` / `TEST_USER_B_PASSWORD` | 계정 B. "본인 소유가 아닌 주문은 거부되는지"(RLS) 검증에만 사용 — A의 주문을 B가 확정/취소 시도했을 때 실제로 막히는지 확인합니다. |
| `TEST_CENTER_ID` | 테스트 주문을 생성할 실제 센터 id. |
| `TEST_PRODUCT_ID` | 테스트 주문을 생성할 실제 상품 id. 운영 데이터가 아닌 소액(또는 0원) 테스트 전용 상품을 하나 만들어 지정하는 것을 권장합니다. |
| `TEST_MANAGER_A_EMAIL` / `TEST_MANAGER_A_PASSWORD` | `tests/integration/admin-assignment-security.test.ts` 전용. **get-or-create** 방식 — TEST_USER_A/B와 동일하게 최초 실행 시 자동 가입됩니다(Auth 계정 + `accounts`/`profiles`). 센터 오너로 연결하는 과정은 아래 "관리자 직접배치 fixture 전략" 참고. |
| `TEST_MANAGER_B_EMAIL` / `TEST_MANAGER_B_PASSWORD` | 위와 동일하지만 **A와 반드시 다른 계정**이어야 합니다. "다른 센터의 관리자는 배치를 시도할 수 없다" 검증 전용으로, A와는 별개의 테스트 센터의 오너가 됩니다. |
| `SUPABASE_SERVICE_ROLE_KEY` | `admin-assignment-security.test.ts`의 fixture 준비(테스트 센터 생성, `manager_centers` 오너 연결)에**만** 쓰는 서비스 역할 키. Supabase 대시보드 → Project Settings → API에서 확인. **절대 `NEXT_PUBLIC_` 접두사를 붙이지 마세요.** 실제 RPC 호출/권한 검증에는 쓰이지 않습니다(아래 참고). |
| `PRODUCTION_SUPABASE_URL` *(선택)* | 운영 Supabase 프로젝트가 생기면 그 URL을 여기에 등록하세요. `NEXT_PUBLIC_SUPABASE_URL`이 이 값과 같으면 통합 테스트 실행 자체를 거부합니다(아래 참고). 지금은 운영 프로젝트가 따로 없어 설정하지 않아도 됩니다. |

### 관리자 직접배치 fixture 전략 (서비스 역할 키를 fixture 준비에만 사용)

`admin-assignment-security.test.ts`의 성공 경로 테스트는 실제 매니저 권한(센터 활성 오너)이 있어야
`admin_assign_reservation`/`admin_cancel_reservation`이 통과합니다. "아직 그 센터의 매니저가 아닌
계정이 스스로를 그 센터의 매니저로 만드는" 과정은 로그인 사용자 client만으로는 RLS를 안전하게
통과한다고 보장할 수 없는 닭-달걀 문제입니다(실제로 `centers` insert에서 RLS 위반으로 막히는 것을
확인함). **`centers` RLS 정책 자체를 테스트 통과를 위해 느슨하게 바꾸지 않고**, 이 fixture 준비
단계만 서비스 역할 키를 쓰는 별도 관리자 client(`tests/integration/setup.ts`의
`getFixtureAdminClient()`)로 RLS를 우회해서 처리합니다.

서비스 역할 client가 하는 일은 정확히 이 두 가지뿐입니다(`getOrCreateOwnedTestCenter()`):
1. 테스트 센터 조회 또는 생성 (`centers`)
2. `manager_centers`에 오너 역할로 연결 (필요 시 `center_roles`에서 오너 역할 id 조회 포함)

그 외 전부 — 수업/수강권 생성(`createFutureTestClass`/`createTestMembership`), 그리고 무엇보다
**실제로 검증 대상인 `admin_assign_reservation`/`admin_cancel_reservation` RPC 호출과 권한
테스트 자체**는 항상 `switchToTestUser()`로 로그인한 사용자별 일반 client(앱이 실제로 쓰는 것과
같은 `lib/supabaseClient.ts` 싱글턴)로 실행됩니다. 그래야 "일반 회원은 차단된다", "다른 센터
관리자는 차단된다" 같은 검증이 실제 RLS/권한 로직을 통과하는 것이지, 서비스 역할로 우회한 결과가
아닙니다.

`SUPABASE_SERVICE_ROLE_KEY`가 없는 파일(기존 결제 통합 테스트 2개)은 `getFixtureAdminClient()`를
아예 호출하지 않으므로 이 값이 없어도 영향받지 않습니다(지연 생성 — 파일 상단에서 미리
`requireEnv`하지 않음).

생성된 센터/오너 연결은 계정과 마찬가지로 다음 실행에 재사용됩니다(매 실행마다 새 센터가 쌓이지
않음).

### 계정 A/B 사전 조건

- Supabase Auth의 **"Confirm email"** 옵션이 켜져 있으면, 최초 실행 시 자동 가입 직후 로그인이
  안 되어 테스트가 실패합니다(에러 메시지에 안내가 포함됩니다). 개발 프로젝트에서는 이 옵션을
  꺼두거나, 이미 이메일 인증이 끝난 계정 정보를 지정해주세요.

### 운영 DB 보호 (환경 분리)

- 통합 테스트는 오직 `.env.test.local`(로컬)/Repository Secrets(CI)에 설정된
  `NEXT_PUBLIC_SUPABASE_URL`을 향해서만 실행됩니다. 앱이 실제로 쓰는 `.env.local`은 통합 테스트
  코드 어디에서도 로드하지 않습니다(완전히 별개 파일).
- `tests/integration/loadEnv.ts`가 `PRODUCTION_SUPABASE_URL`이 설정돼 있고 그 값이
  `NEXT_PUBLIC_SUPABASE_URL`과 같으면 **테스트 실행 자체를 즉시 에러로 중단**시킵니다. 지금은
  운영 Supabase 프로젝트가 따로 없어 이 검사가 활성화되어 있지 않지만, 나중에 운영 프로젝트가
  생기고 그 URL을 `PRODUCTION_SUPABASE_URL`로 등록해두면 테스트 코드를 다시 손보지 않아도
  자동으로 보호막이 켜집니다.
- **책임 소재**: GitHub Repository Secrets에 실제로 어떤 프로젝트의 값을 넣을지는 사람이
  직접 설정하는 부분이라(GitHub UI에서만 가능), Claude/CI가 대신 확인해줄 수 없습니다. Secrets를
  등록할 때 반드시 개발용 프로젝트의 URL/키인지 확인해주세요.
- 참고: `.env.test.local`은 이름이 Next.js가 `NODE_ENV=test`일 때 자동으로 읽는 파일명 규칙과
  같습니다. 이 프로젝트의 `npm run dev`/`npm run build`는 `NODE_ENV=test`를 쓰지 않으므로 실제로
  충돌하지는 않지만, 참고해두세요.

### 테스트 데이터 정리

`orders`/`memberships`/`payments`에는 회원 본인이 삭제할 수 있는 RLS 정책이 없어(관리자만 가능),
통합 테스트가 만든 데이터를 스스로 지우지 못합니다. 개발 프로젝트에 테스트 데이터가 쌓이면
저장소에 이미 있는 `reset_test_data.sql`로 주기적으로 초기화하세요.

`admin-assignment-security.test.ts`는 자신이 만든 예약을 `admin_cancel_reservation`으로 취소한 뒤
예약·수업 행을 삭제합니다(`afterAll`, best-effort — 실패해도 스위트를 실패시키지 않음). 다만:
- `memberships`는 매니저가 delete할 수 있는 RLS 정책이 없어 위와 동일하게 남습니다.
- `admin_action_logs`는 애초에 수정·삭제 정책이 없는 append-only 로그라 설계상 절대 지워지지
  않습니다(의도된 동작).
- 테스트 전용 센터(`manager_centers`/`center_roles` 포함)는 다음 실행에서 재사용하도록 일부러
  지우지 않습니다.

## GitHub Actions

`.github/workflows/test.yml`이 동일한 `npm run test`/`npm run test:integration` 명령을 그대로
사용합니다.

- **단위 테스트**: 모든 push/PR에서 항상 실행(Secrets 불필요).
- **통합 테스트**: push, `workflow_dispatch`(수동 실행), 그리고 **같은 저장소 브랜치 간 PR**에서
  실행됩니다. fork에서 온 PR은 GitHub이 Secrets를 주입하지 않아 애초에 통과할 수 없고, 의도적으로
  제외해 Secrets가 외부 fork에 노출되지 않게 합니다. 이 조건 덕분에 **feature 브랜치 → PR** 단계
  (merge 전)에서 이미 통합 테스트 결과를 확인할 수 있고, merge로 인한 main push에서도 다시
  실행됩니다.
