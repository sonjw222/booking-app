# NICEPAY 도입 전 결제 DB 안전성 보강 설계 (Batch 3) — 2026-10-16

SQL은 **검토용 초안이며 DEV/Production에 실행하지 않았다.** 근거: 운영 DB 읽기 전용 조사 결과(사용자 제공) + 저장소의 최신 라이브 계보 정의. 오프라인 검증: `tests/sql/nicepay-provider-support.test.mjs`(PGlite 10개), `tests/unit/nicepay.*.test.ts`, `pgPaymentLifecycle.test.ts`.

## 1. 확인된 사실과 대응
| # | 사실 | 위험 | 대응(파일) |
|---|---|---|---|
| 1 | `orders_payment_provider_check`, `payments_payment_provider_check`가 mock/toss/portone만 허용 | NICEPAY 주문 INSERT 불가 | B: `add_nicepay_provider_support_20261016.sql` [1] (기존 값 유지) |
| 2 | `create_order_secure`도 같은 3개만 허용 | 해당 RPC로 NICEPAY 주문 생성 불가 | C: §3 (저장소에 정의 없음 → 라이브 정의 확인 후 별도 패치) |
| 3 | `orders_status_check`에 `approving` 없음 | 승인 선점 상태 표현 불가 | D: [2] 추가 |
| 4~5 | `refund_membership` → `_refund_membership_core(..., false, false)`, 일반 환불 차단이 `toss, portone`만 | **NICEPAY 결제 건을 회원이 앱 RPC로 DB에서만 환불(카드 취소 없이) 가능** | A: `fix_refund_block_all_pg_providers_20261016.sql` — 허용 목록(`provider IS NOT NULL AND <> 'mock'`) |
추가 발견: 앱 서버 환불 라우트(`handleRefund`)도 `toss/portone`만 PG로 취급해 NICEPAY 금액>0 건을 DB-only로 흘렸다 → 코드 수정(`refund_unsupported_provider` 501, fail-closed) + 테스트.

## 2. A. 일반 환불 (SQL 1)
- 변경은 `_refund_membership_core`의 exists 조건 한 줄: `payment_provider in ('toss','portone')` → `payment_provider is not null and payment_provider <> 'mock'`. 나머지는 라이브 정의(KST 날짜판) 그대로.
- 유지: 직접결제(NULL)·Mock 환불, 서버 경로(`refund_membership_server`, `p_allow_pg=true`)는 외부 취소 후 PG 건 마무리 가능, helper 실행 권한(owner 외 불가).
- PGlite로 **수정 전 정의가 nicepay 환불을 통과시킴(우회 재현)**과 수정 후 차단을 모두 확인.
- 영향: 기존 toss/portone 동작 동일. 미래 provider 값은 자동 차단. 롤백 시 우회 위험 복귀(nicepay 주문이 없을 때만 사용).

## 3. C. create_order_secure 의 NICEPAY 지원 설계
- 저장소에 정의가 없고(앱 `lib/orders.ts`는 `orders`를 직접 INSERT) 앱 코드 어디서도 호출하지 않는다 → **라이브 전용 함수**. 정의를 모른 채 덮어쓰면 과거 드리프트 사고가 재발하므로 이번에 SQL을 쓰지 않았다.
- 필요한 변경(정의 확인 후 별도 패치): provider 허용 목록에 `'nicepay'` 추가 **한 줄만**. 상품/금액/포인트/쿠폰 검증(`product_amount_snapshot`, `_order_expected_amount`, 포인트 원장 대조)은 그대로 둔다.
- 확인용 읽기 전용 쿼리(사용자 실행):
```sql
select pg_get_functiondef(p.oid) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'create_order_secure';
select grantee, privilege_type from information_schema.routine_privileges where routine_name = 'create_order_secure';
```
- 앱이 이 RPC를 쓰지 않는 현재 구조에서는 `orders` 직접 INSERT 경로가 [1]의 CHECK 확장만으로 NICEPAY를 허용한다. 클라이언트가 임의로 `payment_provider='nicepay'` 주문을 만들 수 있으나 확정은 service_role 전용 `confirm_nicepay_payment`로만 되므로 무료 발급 경로는 아니다.

## 4. D. 상태 모델 (SQL 2)
```
pending ──claim(service)──▶ approving ──confirm_nicepay_payment──▶ paid ─▶ done
   ▲                           │  │
   └──release(claim 일치, tid 없음, 검토 아님)  └─mark_review(netcancel_failed / confirm_state_unknown / stale_claim)
                               │                      │ (approving 유지: 재선점·회원 취소 불가)
                               └─resolve_review(release | cancel) — 운영자, tid 없을 때만
```
- 상태 값은 `approving` 하나만 추가했다. 결과 불명/망취소 실패/수동 확인은 상태가 아니라 `pg_review_reason/pg_review_at` 컬럼으로 표현(상태 enum 확산 방지).
- `pg_claim_id`: 선점 시마다 새 UUID. release/mark_review/confirm 모두 일치해야 하므로 지연된 오래된 요청이 재선점 이후 확정·해제 불가(fencing).
- `pg_tid` 유일 인덱스: 같은 NICEPAY 거래번호를 다른 주문에 재사용할 수 없다. 완료 주문에 다른 TID 확정 시도 거부.
- 보안 약화 없음: 트리거 `orders_guard_pg_state`는 **제한만 추가**한다(로그인 사용자는 pg_* 컬럼·approving 진입/이탈 불가). 기존 `orders_force_server_fields_on_insert`, RLS "주문 본인 취소"(pending/paid만 → approving은 회원 취소 불가), mock 확정(pending→paid→done)은 그대로 동작(테스트 E).
- 오래된 선점(서버 크래시): `nicepay_expire_stale_claims`가 자동 복귀가 아니라 검토 대기로 표시(돈이 승인됐을 수 있음). 크론/운영 도구로 호출 — 호출 주체 설계는 계약 후.

## 5. E. confirm_real_payment 를 확장하지 않은 이유
`confirm_real_payment`는 service_role 전용이지만 **PG 승인 검증을 DB가 하지 못하고** 호출자(서버)를 믿으며, 선점/fencing/TID 유일성이 없다. NICEPAY까지 단순 확장하면 ① 동시 승인·재시도에서 중복 확정 시도를 DB가 구분하지 못하고 ② 다른 주문의 TID 재사용을 막지 못하며 ③ approving 상태 모델과 맞지 않는다. 그래서 별도 `confirm_nicepay_payment`를 만들고 `confirm_real_payment`/`cancel_real_payment`는 수정하지 않았다(NICEPAY 주문에는 계속 거부됨 — 테스트 C).
서버 권한 경계: DB는 PG 응답의 서명·MID를 직접 검증할 수 없다 → 라우트(`lifecycle.ts`)가 서명/금액/MID/Moid/TID를 검증한 뒤에만 service_role로 호출. DB는 provider·상태·claim·금액·TID 유일성과 기존 발급 helper의 금액 재검증으로 2차 방어.

## 6. 적용 순서 / 영향 / 롤백
| 순서 | 파일 | 영향 | 롤백 |
|---|---|---|---|
| 0 | (읽기 전용) 아래 사전 확인 | 없음 | — |
| 1 | `fix_refund_block_all_pg_providers_20261016.sql` | `_refund_membership_core` 1개 함수 재정의(조건 한 줄). 데이터 변경 없음 | `rollback_fix_refund_block_all_pg_providers_20261016.sql` |
| 2 | `add_nicepay_provider_support_20261016.sql` | CHECK 3개 재생성(기존 행 모두 통과해야 함), orders 컬럼 5개·인덱스 2개·트리거 1개·RPC 7개 추가. 데이터 변경 없음. 테이블 락 짧음 | `rollback_add_nicepay_provider_support_20261016.sql` (nicepay/approving/pg_* 데이터가 있으면 중단) |
| 3 | `verify_*` 두 파일 | 읽기 전용 | — |
사전 확인(읽기 전용):
```sql
select conname, pg_get_constraintdef(oid) from pg_constraint where conname in ('orders_payment_provider_check','payments_payment_provider_check','orders_status_check');
select payment_provider, status, count(*) from orders group by 1, 2 order by 1, 2;   -- 기존 값이 모두 새 CHECK에 들어가는지
select count(*) from payments where payment_provider is not null and payment_provider not in ('mock','toss','portone');
select proname, prosecdef, proconfig from pg_proc where proname in ('_refund_membership_core','confirm_real_payment','cancel_real_payment','confirm_test_payment');
```
⚠ 제약 이름이 라이브와 다르면 `drop constraint if exists`가 옛 제약을 남겨 효과가 없을 수 있다 → 사전 확인으로 이름 확인 필수.

## 7. 남은 작업 (이번 범위 밖)
create_order_secure 패치(정의 확인 후) · NICEPAY ReturnURL/웹훅 라우트와 `nicepayDbDeps` 연결 · `NICEPAY_CHECKOUT_ACTIVATED` 해제 · stale claim 크론 · 정산 뷰(`fix_admin_settlement_summary_use_payment_provider.sql`)의 provider 목록에 nicepay 포함 · 복귀 토큰 라우트의 provider 일반화 · 환불 API(nicepay 취소) 연동 후 `handleRefund`에 NICEPAY 분기.
