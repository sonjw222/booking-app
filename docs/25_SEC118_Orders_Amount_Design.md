# SEC-118 — `orders.amount` 클라이언트 신뢰 문제: root cause + 권장 아키텍처

> 상태: 설계만, 코드/SQL 미작성. 별도 P0 Batch로 분리 진행 예정.

## 1. Root cause (코드로 확정)

- `lib/orders.ts`의 `createOrder(input)`가 `input.amount`를 그대로 `orders.amount`에 저장한다.
  `product.price`를 서버에서 재조회·재계산하는 로직이 없다.
- `orders` INSERT RLS(`add_orders.sql`)는 `profile_id in (select my_profile_ids())`만 확인—
  금액 관련 제약이 전혀 없다. CHECK 제약, FK, trigger도 `orders.amount`에는 없음(코드 확인).
- `fulfill_order()`는 `v_order.amount`를 그대로 신뢰해:
  - `memberships`는 `product.total_count` 기준으로 정상 발급(가격과 무관)
  - `payments.total_amount`/`card_amount`/`transfer_amount`/`direct_amount`는 **`v_order.amount`
    그대로** 기록
- 따라서 **상품 가치(수강권 발급량)와 매출 기록 금액이 완전히 분리**돼 있다 — 회원이
  checkout UI를 우회해 임의 `amount`로 주문을 만들고 매니저가 그 주문을 승인(fulfill)하면,
  정상 상품이 조작된 매출 금액으로 발급된다.

## 2. 이 앱의 결제 단계 (설계에 영향)

`docs/TODO.md` P0-1 기준: 아직 **실제 PG 연동 전, Mock/테스트 결제 환경만** 구축된 상태(사업자
등록 후 Toss/PortOne 진행 예정). 즉 지금은 "결제 승인"이 아니라 "매니저가 육안으로 확인하고
승인하는 수동 발급" 성격이 강하다 — 그래서 지금 당장 이 문제로 실제 금전 피해가 나가는
경로는 좁지만(매니저의 승인 행위가 필요), **서버가 가격을 전혀 검증하지 않는다는 사실 자체는
실제 PG 연동 전에 반드시 고쳐야 하는 구조적 결함**이다. 실제 PG 연동 시점엔 결제사가 실제로
받은 금액이 있으므로 그 시점엔 "결제 완료 콜백의 금액"이 추가 신뢰 앵커가 되지만, 그때도
`orders.amount`가 애초에 조작 가능하면 결제 금액과 발급 상품이 다시 분리될 위험이 있다.

## 3. 설계 후보 비교

| 안 | 설명 | 장점 | 단점 |
|---|---|---|---|
| A. `orders` INSERT를 RPC화 + 서버측 `product.price` 계산 | `createOrder`를 `create_order(p_product_id, ...)` RPC로 바꾸고 함수 내부에서 `products.price`를 조회해 `amount`를 서버가 직접 계산 | 가장 근본적, 클라이언트가 amount를 아예 못 보냄 | `lib/orders.ts`/`app/cart`, `app/checkout` 코드 변경 필요(이번 범위 밖) |
| B. `orders`에는 client amount 유지, `fulfill_order()`에서 재검증 | INSERT는 그대로 두되, `fulfill_order()` 시작 시 `product.price`(+ 수량/옵션 있으면 그것까지)를 조회해 `v_order.amount`와 비교, 불일치 시 예외 또는 서버 계산값으로 강제 대체 | SQL 함수 한 곳만 수정, `lib/orders.ts` 무변경 | "정가 판매"만 검증 가능 — 할인/쿠폰/포인트가 생기면 이 비교식 자체를 계속 확장해야 함 |
| C. 결제 provider의 검증된 금액과만 대조 | `payment_provider`별로 실제 승인된 금액(PG 콜백 payload, 또는 Mock의 `confirm_test_payment` 파라미터)을 별도 컬럼/로그로 남기고, `fulfill_order`가 `orders.amount`가 아니라 이 "검증된 금액"만 신뢰 | 실제 PG 연동 이후를 겨냥한 가장 튼튼한 구조(결제사 콜백이 최종 진실) | 아직 실제 PG 연동 전이라 지금 당장은 "검증된 금액" 자체가 없음(Mock 결제는 그 자체가 신뢰 앵커가 아님) — 지금 당장 구현 시 B의 서버 재계산이 사실상 대리 역할을 해야 함 |
| D. A + B 조합(권장) | 신규 주문 경로(A)는 RPC로 막고, `fulfill_order()`에도 방어적으로 재검증(B)까지 둔다 — "입구"와 "승인 직전" 이중 방어 | 가장 안전, A만으로 놓칠 수 있는 경로(예: 관리자 직접배치·자동발급 등 다른 주문 생성 경로)까지 커버 | 구현량 가장 많음 |

**권장: D(A+B 조합).** 이유: A만 적용하면 `orders` INSERT 시점은 안전해지지만, `fulfill_order()`
자체는 여전히 `orders.amount`를 무조건 신뢰하는 함수로 남아 향후 다른 주문 생성 경로(관리자
수동 주문 생성, 프로모션 코드 등)가 추가될 때마다 같은 취약점이 재발할 수 있다. `fulfill_order()`
안에 서버 재계산/검증을 넣어두면 "누가 어떤 경로로 주문을 만들었든" 마지막 관문에서 항상
검증된다.

## 4. 세부 설계 방향 (D안 기준)

1. **`create_order_secure(p_center_id, p_product_id, p_pay_method)` 신규 RPC**(가칭)
   - `products.price`를 서버에서 조회해 `orders.amount`에 그 값을 그대로 insert(클라이언트는
     `amount` 파라미터를 아예 보내지 않음)
   - `products.is_on_sale`/`is_active` 확인(판매 중지 상품 주문 차단 — 현재 `createOrder`가
     이것도 검증 안 하는지 별도 확인 필요, 이번 설계 문서 범위 밖으로 메모만 남김)
   - 기존 `orders` INSERT RLS는 그대로 두되(security definer RPC라 우회 가능하므로), 클라이언트가
     이 RPC를 거치지 않고 `orders`에 직접 insert하는 경로(`lib/orders.ts`의 현재 `createOrder`)는
     **제거하거나 이 RPC를 호출하도록 교체**해야 함(코드 변경, 이번 배치 범위 밖)
2. **`fulfill_order()`에 방어적 재검증 추가**
   ```
   -- (설계 스케치, 실제 SQL 아님)
   select price into v_expected_amount from products where id = v_order.product_id;
   if v_order.product_id is not null and v_order.amount <> v_expected_amount then
       raise exception '주문 금액이 상품 가격과 일치하지 않아요(관리자 문의)';
       -- 또는: v_order.amount를 무시하고 v_expected_amount로 강제 대체 후 진행(운영 정책 결정 필요)
   end if;
   ```
   - **"예외로 막을지" vs "서버값으로 강제 대체 후 진행할지"는 제품 정책 결정 필요** — 전자는
     조작 주문을 매니저가 명시적으로 재검토하게 만들고, 후자는 회원 경험을 안 끊되 "회원이
     실수로/의도적으로 잘못 보낸 금액"이 조용히 고쳐진다는 감사(audit) 이슈가 있음. **막는
     쪽(예외)을 권장** — 조작 시도 자체가 드물어야 정상이므로 막혀도 정상 사용자 경험에
     지장이 없고, 매니저가 이상 신호를 인지할 기회가 생김.
3. **상품 가격 변경 이후 이미 생성된 주문**: `orders.amount`는 주문 생성 시점의 스냅샷이어야
   한다(주문 이후 가격이 올라도 이미 만든 주문은 예전 가격 유지) — 즉 위 재검증은 "주문 생성
   시점의 `products.price`"를 저장해두고 그 값과 비교해야지, `fulfill_order()` 시점에
   `products.price`를 다시 조회해 비교하면 **가격이 바뀐 정상 주문까지 오탐**된다. → **1번
   RPC가 `orders.amount`에 저장한 값 자체가 이미 "생성 시점 스냅샷"이므로, `fulfill_order()`의
   재검증은 `orders.amount`와 "그 주문이 생성된 시점의 값"을 다시 비교할 방법이 없다**는 뜻이다.
   해결: `orders`에 `verified boolean not null default false`(또는 `amount_source text` 등)
   컬럼을 추가해 "1번 RPC를 거쳐 만들어진 주문인지" 표시하고, `fulfill_order()`는 `verified=true`
   인 주문만 처리하도록 하는 편이 재조회 방식보다 안전(경합·가격변동 문제 자체를 회피).
4. **할인/쿠폰/포인트 확장 대비**: `orders`에 `discount_amount`(이미 `lib/orders.ts`에 필드가
   보임, 코드 확인)가 있다면 `amount = product.price - discount_amount`처럼 서버가 할인까지
   계산하는 구조로 확장 가능하게 RPC 파라미터를 `p_coupon_code`/`p_point_used`처럼 설계해두는
   것을 권장(지금 당장 구현하지 않더라도 함수 시그니처에 여지를 남겨두면 나중에 breaking
   change 없이 확장 가능).
5. **goods/pass 모두 검증**: `products.product_kind in ('pass','goods')` 둘 다 `price` 컬럼을
   공유하므로 위 로직은 종류 구분 없이 동일하게 적용 가능(현재 코드도 kind로 분기하지 않음,
   확인됨).

## 5. 필요한 변경 파일(실제 구현 시, 지금은 작성 안 함)

- 신규 SQL: `add_create_order_secure_draft_proposed.sql`(신규 RPC) 또는
  `fix_orders_amount_server_verification_draft_proposed.sql`(B안만 최소 적용할 경우)
- `lib/orders.ts`: `createOrder()`를 신규 RPC 호출로 교체(또는 최소안이면 무변경)
- `tests/integration/orders-amount-tampering.test.ts`(신규): 조작된 amount로 주문 생성 시도 →
  거부/무시 확인, 정상 가격 주문은 그대로 통과 확인
- `docs/TODO.md`: SEC-118 항목을 "설계 완료 → 구현 대기"로 갱신

## 6. 이번 배치에서 하지 않는 것

- 위 SQL/코드는 전혀 작성하지 않았다(설계 문서만).
- `orders`/`products` 테이블 스키마 변경 없음.
- `fulfill_order()`/`createOrder()` 무변경.
