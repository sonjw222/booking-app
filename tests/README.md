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
| `PRODUCTION_SUPABASE_URL` *(선택)* | 운영 Supabase 프로젝트가 생기면 그 URL을 여기에 등록하세요. `NEXT_PUBLIC_SUPABASE_URL`이 이 값과 같으면 통합 테스트 실행 자체를 거부합니다(아래 참고). 지금은 운영 프로젝트가 따로 없어 설정하지 않아도 됩니다. |

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

## GitHub Actions

`.github/workflows/test.yml`이 동일한 `npm run test`/`npm run test:integration` 명령을 그대로
사용합니다.

- **단위 테스트**: 모든 push/PR에서 항상 실행(Secrets 불필요).
- **통합 테스트**: push, `workflow_dispatch`(수동 실행), 그리고 **같은 저장소 브랜치 간 PR**에서
  실행됩니다. fork에서 온 PR은 GitHub이 Secrets를 주입하지 않아 애초에 통과할 수 없고, 의도적으로
  제외해 Secrets가 외부 fork에 노출되지 않게 합니다. 이 조건 덕분에 **feature 브랜치 → PR** 단계
  (merge 전)에서 이미 통합 테스트 결과를 확인할 수 있고, merge로 인한 main push에서도 다시
  실행됩니다.
