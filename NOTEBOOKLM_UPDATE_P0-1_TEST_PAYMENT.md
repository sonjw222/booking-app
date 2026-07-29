# NotebookLM 업데이트 — P0-1 테스트 결제 환경 구축

> 이 문서는 NotebookLM에 그대로 업로드할 수 있도록 작성했습니다. 브랜치 `feature/p0-test-payment`,
> 아직 main에 병합되지 않은 상태(사용자 승인 대기)를 기준으로 합니다.

## 1. 변경 목적

아직 사업자 등록이 없어 Toss/PortOne 운영 키를 쓸 수 없는 상태에서, **운영 전환을 고려한 테스트 결제 환경**을 구축했습니다. 목표는 "테스트 결제 자체"가 아니라 **"나중에 API Key/Client Key/Webhook/Provider만 교체하면 비즈니스 로직(Checkout/Reservation/Order) 수정 없이 운영 전환이 가능한 구조"**를 만드는 것입니다.

기존에 이미 있던 "결제하기 → 주문 접수(pending) → 매니저가 수동 확인·발급" 흐름은 그대로 두되(다른 어떤 화면도 이 경로를 여전히 쓸 수 있음 — 예: `app/cart/page.tsx`), 신규로 만든 `/checkout` 단일 상품 결제 경로만 **Payment Adapter를 통한 즉시 자동 발급**으로 바꿨습니다.

## 2. Payment Layer 설계

```
app/checkout/page.tsx (Client Component)
  └─ lib/payments/index.ts  ← 유일한 공개 진입점, 외부는 이것만 import
       └─ getPaymentService(scenarioOverride?)
            └─ PaymentService (구체 Provider를 모름, 인터페이스만 앎)
                 └─ PaymentProviderFactory.getProvider()
                      ├─ MockPaymentProvider    (실동작)
                      ├─ TossPaymentProvider    (구조만)
                      └─ PortOnePaymentProvider (구조만)
                           └─ (RPC: confirm_test_payment / cancel_test_payment)
                                └─ orders / memberships / payments 테이블
                                     └─ Reservation 자동 복귀 (기존 로직, 무수정)
```

**의존성 역전(DIP)**: `PaymentService`는 `Mock`/`Toss`/`PortOne` 클래스를 단 한 줄도 import하지 않습니다. 오직 `PaymentProvider` 인터페이스(`types.ts`)만 참조하며, 실제 구현체는 `PaymentProviderFactory`가 `NEXT_PUBLIC_PAYMENT_PROVIDER` 환경변수를 보고 조립해 주입합니다.

### 새 구조 도입 근거 (요청에 따라 사전 설명)
- **`lib/payments/` 폴더**: 결제는 이 프로젝트에서 유일하게 "동일 계약을 여러 구현체가 만족해야 하는" 도메인이라, 기존 `lib/*.ts`(테이블 1~2개를 감싸는 단일 파일 컨벤션)로는 인터페이스·구현체 3종·오케스트레이터를 깔끔히 분리할 수 없었습니다. 새 Provider가 늘어나도 다른 폴더는 전혀 손댈 필요가 없어, "Provider만 교체" 요구사항을 물리적으로 구현합니다.
- **`PaymentProviderFactory`**: Factory 없이 `PaymentService`가 구체 클래스를 직접 생성하면 DIP가 깨집니다. 이 프로젝트에 처음 등장하는 패턴이지만, 런타임에 구현체 하나를 선택해야 하는 유일한 도메인이라 여기에만 한정해 도입했습니다(다른 도메인 확산 계획 없음).

## 3. Payment Adapter 구조

```ts
// lib/payments/types.ts
interface PaymentProvider {
  createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult>;
  confirmPayment(paymentKey: string, orderId: string): Promise<ConfirmPaymentResult>;
  cancelPayment(orderId: string): Promise<CancelPaymentResult>;
  getPaymentStatus(orderId: string): Promise<PaymentStatusResult>;
}
```
- `MockPaymentProvider`: 4개 메서드 전부 실동작
- `TossPaymentProvider` / `PortOnePaymentProvider`: 구조만(메서드마다 "아직 구현되지 않았어요" 에러) — 각 파일 상단 주석에 운영 전환 시 채워야 할 항목을 구체적으로 남겨둠(Client Key/Secret Key 위치, SDK 호출 지점, 웹훅 필요성 등)

## 4. Factory 구조

```ts
// lib/payments/PaymentProviderFactory.ts
function resolveProviderName() {
  const raw = process.env.NEXT_PUBLIC_PAYMENT_PROVIDER; // "toss" | "portone" | 그 외 → "mock"
  ...
}
export function getPaymentProvider(mockScenarioOverride?) {
  switch (resolveProviderName()) {
    case "toss": return new TossPaymentProvider();
    case "portone": return new PortOnePaymentProvider();
    default: return new MockPaymentProvider(mockScenarioOverride);
  }
}
```
`NEXT_PUBLIC_` 접두사를 쓴 이유: 이 프로젝트는 `app/api/` 라우트가 전혀 없는 100% 클라이언트 컴포넌트 구조이고, Checkout도 `"use client"`입니다. Next.js는 접두사 없는 환경변수를 브라우저 번들에 노출하지 않으므로, 지금 구조에서 `PaymentProviderFactory`가 실제로 값을 읽으려면 이 접두사가 필수입니다. 향후 웹훅(서버 라우트)이 생기면 그때 서버 전용 값(예: `TOSS_SECRET_KEY`)을 별도로 분리합니다.

## 5. Mock Provider 구조 (3가지 시나리오)

`NEXT_PUBLIC_PAYMENT_SCENARIO` 환경변수(`success` | `failed` | `cancelled`, 기본값 `success`) 또는 checkout 화면의 `?mockScenario=` 쿼리 파라미터(재빌드 없이 즉시 테스트용, 쿼리가 있으면 env보다 우선)로 선택합니다.

| 시나리오 | `confirmPayment()` 동작 | DB 반영 | Checkout 화면 | Reservation 화면 |
|---|---|---|---|---|
| `success` | `confirm_test_payment` RPC 호출 | `orders`→paid→done, `memberships` insert, `payments` insert(status=paid) | "테스트 결제가 완료됐어요" + 1.8초 후 예약 화면 자동 복귀 | 재조회 시 수강권 즉시 사용 가능 → "바로 예약을 진행할 수 있어요" 토스트 |
| `failed` | RPC 호출 없음(주문 그대로 pending 유지) | 변경 없음(재시도 가능) | 에러 토스트 "결제에 실패했어요. 다시 시도해주세요." 표시, 체크아웃 화면에 머무름 | 영향 없음(애초에 도달하지 않음) |
| `cancelled` | `cancel_test_payment` RPC 호출 | `orders.status`→`cancelled` | 에러 토스트 "결제가 취소됐어요. 다시 시도해주세요." | 영향 없음 |

## 6. 변경된 페이지/컴포넌트
- `app/checkout/page.tsx`: `handlePay()`가 주문 생성 이후 `PaymentService`를 통해 결제를 확정하도록 변경. 결과에 따라 성공(`done` 화면, 기존 UI 그대로)/실패·취소(기존 에러 토스트 재사용) 분기. 안내 문구 3곳을 "테스트 결제(Mock)임"이 드러나도록 갱신.
- `app/reservation/page.tsx`: **무수정.** 기존 "즉시 가능/발급 대기" 토스트 분기가 실제 DB 상태를 재조회해 판단하도록 이미 설계돼 있어, Mock 성공 시 자동으로 정확한 문구가 나옵니다.

## 7. 변경된 RPC
| RPC | 상태 | 비고 |
|---|---|---|
| `confirm_test_payment(p_order_id, p_provider_ref)` | 신규 | 본인 소유 + `payment_provider='mock'` 한정, security definer |
| `cancel_test_payment(p_order_id)` | 신규 | 위와 동일 조건 |
| `fulfill_order(p_order_id)` | **무수정** | 매니저 전용 경로 그대로 유지 |

## 8. 변경된 SQL / DB 구조
- 신규 파일: `add_payment_test_provider.sql` (schema.sql 무수정)
- 신규 컬럼: `orders.payment_provider text` (nullable, `mock`/`toss`/`portone`만 허용하는 check 제약, 기본값 null=레거시 경로)
- 기존 컬럼 재사용: `payments.pg_transaction_id`, `payments.status`(스키마에 이미 있던 PG 연동용 자리 — 이번에 처음 실제로 채워 넣음)

## 9. 운영 PG 전환 방법 (사업자 등록 후)
1. `.env`의 `NEXT_PUBLIC_PAYMENT_PROVIDER`를 `mock` → `toss`(또는 `portone`)로 변경
2. `TossPaymentProvider`/`PortOnePaymentProvider`의 메서드 본문 구현(각 파일 상단 주석에 할 일 정리됨)
3. 실제 결제 확정용 신규 RPC(예: `confirm_real_payment`) 추가 — `confirm_test_payment`는 재사용하지 않음(`payment_provider='mock'` 가드로 원천 차단됨)
4. 웹훅 핸들러(`app/api/webhooks/...`, 신규) 추가해 비동기 결제 승인 처리
5. **`Checkout`/`Reservation`/`Order` 코드는 위 4단계 동안 단 한 줄도 수정하지 않음** — 이게 이번 설계의 핵심 검증 포인트

## 10. 자동 테스트 환경 (신규)
UI/UX는 사용자가 직접 확인하고, **시스템 레벨(RPC/RLS/DB 정합성)만 자동화**했습니다.

- **도구**: Vitest(신규 devDependency). Playwright는 이번 범위(UI 자동화 아님)에 불필요해 도입하지 않음.
- **단위 테스트**(`npm run test`, `tests/unit/`) — 실제 Supabase 접속 없음. `mockPaymentApi`를 mock해 `MockPaymentProvider`의 success/failed/cancelled 분기, `PaymentProviderFactory`의 provider 선택 로직만 검증. 12개 테스트, 항상 빠르게 통과.
- **통합 테스트**(`npm run test:integration`, `tests/integration/`) — 실제 개발용 Supabase에 실제 RPC 호출. 계정 A/B를 **get-or-create**(로그인 시도 → 실패하면 가입 → `accounts`/`profiles` 없으면 생성, 있으면 재사용)로 준비한 뒤:
  - 성공/취소 결제 → `orders`/`memberships`/`payments` 실제 행까지 검증
  - 순차 중복 호출 + **동시(`Promise.all`) 중복 호출**까지 idempotency 검증(RPC의 `for update` 행 잠금 실증)
  - RLS: 계정 B가 계정 A 주문 확정 시도 → 거부, `payment_provider≠mock` 주문 확정 시도 → 거부, 존재하지 않는 주문 → 명확한 에러
- **필요 설정**(`.env.test.local`, 템플릿 `.env.test.local.example` 제공): Supabase URL/키, 테스트 계정 A/B 이메일·비밀번호, 테스트용 센터/상품 id. Supabase Auth의 "Confirm email"이 켜져 있으면 최초 자동 가입 직후 로그인이 안 될 수 있어 개발 프로젝트에서는 꺼두는 것을 권장(에러 메시지에 안내 포함).
- **GitHub Actions**(`.github/workflows/test.yml`, 신규): 모든 push/PR에 단위 테스트 실행. 통합 테스트는 `pull_request` 이벤트에서는 제외(fork에는 Secrets가 주입되지 않음)하고, push/수동 실행(`workflow_dispatch`)에서만 Repository Secrets로 실행.
- **자동화하지 않은 것**: 테스트 데이터 정리(cleanup) — `orders`/`memberships`/`payments`에 회원 본인 DELETE RLS 정책이 없어 테스트가 스스로 지울 수 없음. 기존 `reset_test_data.sql`로 주기적 수동 초기화를 권장.

## 11. CHANGELOG 추가 내용
`docs/CHANGELOG.md`에 2026-07-30 항목 2건으로 기록(결제 어댑터 구현 + 자동 테스트 환경, 각각 위 절 요약과 파일 목록 포함).

## 12-1. 커밋 전 3가지 확인 사항 (2026-07-30 재검토)
1. **GitHub Actions 타이밍**: `.github/workflows/test.yml`의 통합 테스트 `if` 조건이 모든
   `pull_request` 이벤트를 건너뛰던 문제를 발견해 수정 — 이제 "같은 저장소 브랜치 간 PR"에서는
   merge 전에도 실행되고, fork PR만 제외됩니다(Secrets 노출 방지).
2. **환경변수 문서화**: `tests/README.md`(신규) + 루트 `README.md`에 "테스트" 섹션 추가 — 변수별
   용도, get-or-create 계정 전제조건, GitHub Secrets 등록 방법 정리.
3. **운영 DB 분리 재확인**: `tests/integration/loadEnv.ts`에 `PRODUCTION_SUPABASE_URL` 가드 신설
   (일치 시 실행 자체를 차단) + 직접 실행해 정상 동작 확인함. 단, 이 저장소는 현재 Supabase
   프로젝트가 하나뿐이라(운영 프로젝트가 따로 없음) 이 가드는 지금은 잠재적 안전장치이고, 실제로
   어떤 프로젝트 값을 Secrets에 등록할지는 여전히 사람이 직접 확인해야 하는 부분입니다.

## 12. TODO 변경 사항
`docs/TODO.md`의 `P0-1` 항목 상태를 "미완성" → "미완성(테스트 결제 환경만 완료)"로 갱신하고, `fulfill_order` ↔ `confirm_test_payment` 중복에 대한 **왜/어떻게 공통화/향후 계획** 3가지를 명시적으로 기록했습니다(요청하신 항목).
