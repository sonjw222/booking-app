# NICEPAY 도입 전 결제 DB 안전성 보강 설계 (Batch 3) — 2026-10-16

> **Batch 3 보완판(운영 DB 실측 반영)은 §8이 최신이다.** §4의 RPC 목록·§6의 영향 표 중 §8과 다른 부분(RPC 8개, `nicepay_release_order` 근거 인자, `nicepay_resolve_review` 증거 인자, 상태 전이 트리거 확장, 제자리 패치 3건, 감사 테이블)은 §8이 우선한다.

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
| 2 | `add_nicepay_provider_support_20261016.sql` | CHECK 3개 재생성, orders 컬럼 5개·인덱스 2개·보호 트리거 1개, 상태 전이 트리거 함수 교체, 감사 테이블 1개, RPC 8개, 제자리 패치 3건(§8). 데이터 변경 없음. 테이블 락 짧음 | `rollback_add_nicepay_provider_support_20261016.sql` (nicepay/approving/pg_* 데이터가 있으면 중단) |
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

## 8. Batch 3 보완 (운영 DB 실측: 상태 전이 트리거 · payments.payment_provider)

### 8-1. 발견과 대응
| 발견 | 영향 | 대응 |
|---|---|---|
| `orders_guard_status_transition()`이 pending→paid/done/cancelled, paid→done/cancelled만 허용 | 초안 SQL의 `approving` 전이(claim/release/resolve/confirm)가 **라이브에서는 전부 실패**. 초안 PGlite 테스트는 이 트리거를 설치하지 않아 놓쳤다 | 트리거 함수 확장(트리거 자체는 그대로). PGlite 월드에 **실제 트리거**를 설치해 재검증(E1은 확장 전 트리거로 되돌리면 같은 RPC가 실패함을 재현) |
| `_issue_membership_and_record_payment()`가 `payments.payment_provider`를 기록하지 않음 | NICEPAY 결제 행 provider 누락 → 정산 요약(`in ('toss','portone')`)에서 누락 가능 | 제자리 패치: NICEPAY 주문만 `'nicepay'` 기록, 그 외는 지금처럼 NULL. 확정 함수가 결제 행의 provider/TID/금액/건수를 사후 검증 |
| 정산 요약이 toss/portone만 포함 | NICEPAY 수납액이 센터 정산에서 빠짐 | 제자리 패치로 `'nicepay'` 포함 |
| `fulfill_order()`가 provider를 보지 않음 | 매니저가 PG 승인 전 NICEPAY 주문을 발급 가능 | 제자리 패치: NICEPAY 주문 거부(이미 done이면 기존 멱등 응답) |
| 매니저/회원 UPDATE로 `pending→paid/done` 가능(기존 전이 허용) | NICEPAY 주문이 PG 없이 paid/done이 될 수 있음 | 트리거 확장: NICEPAY 주문의 paid/done 전이는 서버 함수 표시 없이는 불가(회원 `pending→cancelled`는 유지) |

### 8-2. 상태 전이 규칙 (확장 후)
- **그대로**: 같은 상태 통과 · cancelled/done 종료 · pending→paid/done/cancelled · paid→done/cancelled (toss/portone/mock/직접결제 NULL). PGlite E2가 4개 provider × 7개 전이를 실제 트리거로 검증.
- **추가(표시 `app.nicepay_write='on'` + `provider='nicepay'`일 때만)**: pending→approving, approving→pending, approving→cancelled, approving→paid(`pg_tid`·`pg_claim_id` 필수), paid→done. `approving→done` 직접 전이 불가.
- **표시 없이 가능한 NICEPAY 전이는 `pending→cancelled` 하나**(기존 회원 본인 취소/매니저 취소 유지).
- 표시는 8개 `SECURITY DEFINER` 함수만 트랜잭션 로컬로 세우고(`set_config(..., true)`) 함수 끝에서 해제한다. 로그인 사용자 차단은 별도 트리거(`orders_guard_pg_state`, `auth.uid()` 있으면 pg_* 컬럼·approving 진입/이탈·nicepay provider 변경 불가)가 담당 — 이중 방어.

### 8-3. Provider 저장/검증
- 기록: NICEPAY 주문 → `payments.payment_provider='nicepay'`, `pg_transaction_id=TID`, `total_amount=주문 금액`. 다른 provider는 INSERT 열을 비워 **기존과 바이트 단위로 동일**(PGlite C: 적용 전/후 toss·portone 결제 행 deepEqual, provider NULL).
- 검증: `confirm_nicepay_payment`가 확정 직후 `sale_type='new'` 결제가 정확히 1건이고 provider/TID/금액이 주문과 일치하는지 확인, 아니면 **전체 롤백(수강권 없음)**(G2: helper 패치를 되돌린 상태에서 확정하면 실패하고 아무것도 남지 않음).
- 과거 데이터는 수정하지 않는다. 참고(발견): 과거 Toss 결제도 helper가 provider를 기록하지 않았다면 `payments.payment_provider`가 NULL이라 **정산 요약(`in ('toss','portone')`)에 잡히지 않았을 수 있다** — 이는 기존 동작이며 이번 변경 범위 밖이다. 확인 쿼리(읽기 전용): `select payment_provider, count(*) from payments where pg_transaction_id is not null and pg_transaction_id not like 'mock_%' group by 1;` 백필이 필요하면 별도 승인.
- 매출 통계(`payment_provider is distinct from 'mock'`)는 nicepay를 실매출로 포함, 환불 행은 기존처럼 provider NULL(PGlite G5).

### 8-4. 수동 복구 증거·감사
- `nicepay_review_actions`: 추가 전용(UPDATE/DELETE 트리거로 superuser도 불가), RLS 활성+정책 없음+클라이언트 권한 회수, service_role만 insert/select.
- 자동 경로도 기록: 복귀(`release`: 근거 `approve_rejected`/`netcancel_confirmed`), 검토 표시(`mark_review`: 사유), 만료 표시.
- 수동 해소 `nicepay_resolve_review(order, action, evidence_type, evidence_ref, actor, note)`: **증거 유형·번호(4자+)·처리자(2자+) 없으면 거부**. release는 `netcancel_confirmed`/`not_approved_confirmed`만, cancel은 + `pg_cancel_confirmed`. 거래번호가 기록된 주문은 풀 수 없다(승인된 거래는 확정 경로로만).
- 수동 확정 `nicepay_confirm_reviewed`: 승인 확인 증거와 함께만 가능. 검토 대기 주문은 `confirm_nicepay_payment` 직접 호출이 막혀 있다. 실패한 시도는 감사 행도 롤백.
- **한계(정직하게)**: 증거 번호가 사실인지는 DB가 검증할 수 없다. DB가 보장하는 것은 "증거 없이는 못 풀고, 누가·언제·무엇을 근거로 했는지가 변경 불가로 남는다"까지다. `actor`는 운영 도구가 넘기는 문자열이라 위조 가능성은 운영 도구 권한 관리에 달려 있다.

### 8-5. 추가 보안 검토 결과
| 항목 | 결과 |
|---|---|
| 결과 불명 시 중복 승인 | PASS: 검토 대기 주문은 claim/재선점 불가(F1), 자동 복귀 불가 |
| 실제 PG 취소 확인 전 수동 release/cancel | PASS(증거 필수, 단 증거 진위는 운영 책임) |
| TID 중복 사용 | PASS: 유일 인덱스, 다른 거래로 덮어쓰기 거부(G1) |
| PG 결제 완료 전 수강권 발급 | PASS: fulfill_order 거부, 직접 UPDATE로 paid/done 불가, 확정은 approving+claim 일치 필요(G1·G4·E3) |
| 오래된 claim 임의 승인 | PASS: 재선점 후 이전 claim 확정/해제 불가(F1·G1) |
| 기존 Toss 완료 거래 환불 | PASS: 일반 환불 차단·서버 경로 환불 동일(C2) |

### 8-6. 적용 전제 (PASS / BLOCKED)
| 전제 | 상태 |
|---|---|
| 저장소 SQL이 라이브 계보와 일치함을 앱이 아닌 DB가 스스로 확인 | **PASS(설계)**: 제자리 패치는 위치가 정확히 1곳이 아니면 전체 중단(PGlite I), 상태 전이 트리거는 사전 점검 DO 블록이 `허용되지 않는 주문 상태 변경이에요` 포함 여부 확인 |
| 라이브 `orders_guard_status_transition` 정의가 이 저장소의 4전이 정의와 같다 | **PASS(사용자 실측 일치)** — 단 정확한 텍스트 일치는 적용 시 사전 점검이 재확인 |
| 라이브 `_issue_membership_and_record_payment` / `fulfill_order` 본문이 저장소 KST판과 일치 | **BLOCKED(적용 시점 확인)**: 불일치하면 SQL이 스스로 중단. 사전에 읽기 전용 `pg_get_functiondef` 비교 권장 |
| 라이브 `admin_center_settlement_summary` 존재 및 패턴 일치 | **BLOCKED(미확인)**: 없으면 건너뛰고, 있는데 패턴이 다르면 중단 |
| CHECK 제약 이름(`orders_payment_provider_check` 등)이 라이브와 같다 | **PASS(사용자 실측)** |
| `create_order_secure` 정의 | **BLOCKED**: 저장소에 없음. 이 SQL과 독립, 별도 패치 필요(§3) |
| 실제 NICEPAY 연동/라우트 | **BLOCKED**(계약·MID/KEY) — 이 SQL은 연동 없이도 안전(함수는 호출되기 전까지 휴면) |

## 9. Batch 3 운영 호환성 보완 (운영 DB 읽기 전용 실측 반영 #2)

### 9-1. 실측 → 대응
| 실측 | 문제 | 대응 |
|---|---|---|
| 운영 `fulfill_order()`에 `[NEW 2026-10-02]` 주석이 **없음** (cancelled 차단 코드는 있음) | 문자열 치환 위치 불일치 → SQL 중단 | 위치를 **코드 구조**로 지정: done 멱등 처리 → `if v_order.status = 'cancelled' then raise exception '취소된 주문은 발급할 수 없어요'; end if;` 바로 뒤 1곳. 주석 유무·들여쓰기 무관(정규식), done이 cancelled보다 앞인지도 검증 |
| 운영 `_issue_membership_and_record_payment()` 정의에 **CRLF** | LF 기반 치환 실패 위험 | 모든 치환을 `\s+` 정규식으로 교체, 삽입 줄바꿈은 대상 정의의 줄바꿈(CRLF/LF)에 맞춤. INSERT 열 목록 끝 `memo` 와 값 목록 끝 `p_memo` 가 **각각 정확히 1곳**일 때만 패치 |
| `create_order_secure(uuid,text,text,integer,boolean,text)` 허용 provider = mock, toss, portone | NICEPAY 주문 생성 불가 | 별도 최소 SQL `fix_create_order_secure_allow_nicepay_20261016.sql`: 목록 `'mock','toss','portone'` 가 정확히 1곳일 때 `'nicepay'`만 추가 |

### 9-2. 안전 장치 (예상과 다른 구조는 모두 중단)
- 패치 위치 개수가 1이 아니면 `raise exception` → 트랜잭션 전체 롤백(CHECK/컬럼/트리거 포함). 이미 패치된 함수는 건너뛰는 멱등 구조.
- 삽입 코드는 표지 주석(`-- fulfill_nicepay_guard begin/end`, `-- nicepay_pg_cancel_guard begin/end`) 또는 정확히 역치환 가능한 조각이라 롤백이 **원문 그대로** 복원한다(PGlite P: LF/CRLF × 주석 유무 4형태에서 적용 전 5개 함수 정의 == 롤백 후).
- **읽기 전용 사전 점검**: `preflight_nicepay_patch_targets_20261016.sql` — 같은 정규식으로 운영 정의의 패치 위치를 미리 센다. 모두 true여야 적용이 중단 없이 끝난다. (이 점검은 DDL/DML이 없다.)
- 상태 전이 트리거 사전 점검도 정규식(CRLF/공백 무관)으로 기존 4전이를 확인.

### 9-3. NICEPAY 환불은 실제 PG 취소 확인 후에만
- 신규 `nicepay_pg_cancels`(추가 전용, RLS, service_role만) + `nicepay_record_pg_cancel(order, cancel_tid, amount, source, actor)`: 승인 완료된 NICEPAY 주문의 **전액 취소**만 기록(출처 `api_response`=서버가 취소 API 응답·서명 검증, `admin_console`=운영자 확인). 주문당 1건, 취소 거래번호 유일, 승인 거래번호와 같으면 거부.
- `_refund_membership_core` 패치: NICEPAY && 금액>0 이면 취소 확인 기록이 없을 때 **서버 경로(`p_allow_pg=true`, 시간 조건 생략 포함)도 거부**. 회원 일반 환불은 기존 허용 목록으로 항상 차단. 0원 주문·다른 provider는 영향 없음.
- 앱 서버(`handleRefund`)는 NICEPAY 취소 API 연동 전까지 금액>0을 501로 거부(변경 없음). 연동 후 순서: 취소 API → 응답 서명 검증 → `nicepay_record_pg_cancel` → `refund_membership_server`.

### 9-4. ⚠ 적용 순서 주의
`fix_refund_block_all_pg_providers_20261016.sql` 은 `_refund_membership_core` 를 **통째로 교체**한다. 따라서 반드시 `add_nicepay_provider_support_20261016.sql` **보다 먼저** 적용해야 한다. 순서가 뒤바뀌면 NICEPAY 취소 확인 가드가 지워진다(`verify_add_nicepay_provider_support_20261016.sql` 의 `refund_core_requires_pg_cancel_must_be_true` 가 false로 잡는다). 이미 support가 적용된 뒤 환불 수정 파일을 다시 실행해야 한다면 support 파일을 한 번 더 실행하면 가드가 복구된다(멱등).

### 9-5. SQL 적용 순서 (최종)
0. (읽기 전용) `preflight_nicepay_patch_targets_20261016.sql` — 모든 `*_ok` true 확인
1. `fix_refund_block_all_pg_providers_20261016.sql`
2. `add_nicepay_provider_support_20261016.sql`
3. `fix_create_order_secure_allow_nicepay_20261016.sql`
4. (읽기 전용) `verify_fix_refund_block_all_pg_providers_20261016.sql`, `verify_add_nicepay_provider_support_20261016.sql`
롤백은 역순: `rollback_fix_create_order_secure_allow_nicepay_20261016.sql` → `rollback_add_nicepay_provider_support_20261016.sql` → `rollback_fix_refund_block_all_pg_providers_20261016.sql`.

### 9-6. 한계 (정직하게)
- 이 저장소에는 **운영 함수의 실제 정의 텍스트가 없다**(특히 CRLF 판 `_issue_membership_and_record_payment`, 주석 없는 `fulfill_order`, `create_order_secure`). 오프라인 테스트는 저장소 정의를 변환(CRLF화, 주석 제거)한 형태와, `create_order_secure`는 **가정한 형태 3종**으로 검증했다. 실제 운영 텍스트와의 일치는 `preflight` 로 적용 직전에 확인한다 — 불일치하면 SQL이 스스로 중단하므로 데이터·함수가 망가질 위험은 없지만, 적용이 막힐 수는 있다.

## 10. Batch 3 최종 SQL 안전 검증 (운영 DB 읽기 전용 실측 PASS 반영)

운영 DB 읽기 전용 실측(사용자 제공): `fulfill_order` done/cancelled 수정 위치 각 1곳, 발급 helper 수정 위치 각 1곳, `create_order_secure` provider 목록 1곳, 정산 요약 1곳, 환불 core 차단 위치 1곳 — 모두 PASS. 운영에는 NICEPAY 주문·approving 주문·NICEPAY 전용 테이블/RPC가 아직 없고, 기존 Toss 완료 주문 3건이 있다.

### 10-1. 정적 검토에서 발견한 보안 문제와 수정
| # | 문제 | 위험 | 수정 |
|---|---|---|---|
| 1 | `confirm_nicepay_payment`/`nicepay_confirm_reviewed`가 호출자가 넘긴 TID·금액을 그대로 신뢰 | **증빙 문자열(임의 TID)만으로 수강권 발급 가능**(서비스 롤 오남용·운영 도구 실수) | 신규 `nicepay_pg_approvals`(추가 전용): 서버가 승인 응답(서명·MID·금액·Moid·TID)을 검증한 직후 `nicepay_record_verified_approval`로만 기록. 확정·수동 확정은 **기록의 (주문, 선점, TID, 금액)이 모두 일치해야** 가능. 응답이 유실돼 승인 기록이 없는 거래는 수동 확정 자체가 불가(PG에서 취소 후 release/cancel로만 정리) |
| 2 | `nicepay_record_pg_cancel`이 아무 TID/증빙 문자열로 취소 확인을 기록 가능 | **증빙만으로 내부 환불 가능**(PG에는 돈이 남은 채 수강권만 환불) | 서버가 검증한 승인 기록의 TID에 대해서만 기록 가능, `api_response`는 응답 요약값(sha256) 필수, `admin_console`은 **처리자≠승인자(2인 승인)** 필수. 환불 core는 `orders.pg_tid`와 일치하는 취소 기록이 있어야 진행 |
| 3 | 수동 release/cancel이 증빙 문자열만으로 가능 | PG에서 이미 승인된 거래를 풀어 **재결제 유도 → 이중 청구** | 승인 기록이 있는 선점은 PG 취소 확인 기록이 있어야만 release/cancel 가능. 모든 수동 해소는 2인 승인·증거 유형 제한(감사 기록에 승인자 저장) |
| 4 | 자동 `nicepay_release_order`가 승인 기록이 있던 선점도 풀 수 있음 | 망취소 확인 없이 복귀 | 승인 기록이 있고 취소 확인 기록이 없으면 `false`(앱은 검토 대기로 표시). 앱 lifecycle이 망취소 성공 응답을 기록한 뒤에만 release |
| 5 | 취소 기록이 주문당 1건(unique order_id) | 재시도(취소 후 재결제)된 주문의 두 번째 거래를 기록 못 함 | 유일 키를 (order_id, pg_tid)로, 환불 core는 확정된 TID(orders.pg_tid)와 대조 |
| 6 | 새 테이블의 식별 시퀀스 권한 | Supabase 기본 권한으로 클라이언트 롤이 시퀀스에 닿을 수 있음 | 시퀀스 3개 `revoke all ... from public, anon, authenticated` |

### 10-2. SECURITY DEFINER / 권한 경계 (PGlite V·H 테스트로 고정)
- 새/교체 함수 15개 모두 `SECURITY DEFINER` + `set search_path = public`, `revoke all ... from public, anon, authenticated`. RPC 10개만 `service_role`에 `grant execute`(트리거/보조 함수는 아무에게도 grant 안 함).
- 새 테이블 3개(감사·승인·취소 확인): RLS 활성(정책 없음), 클라이언트 롤 권한 회수, `service_role`은 select/insert만(update/delete 없음), 추가 전용 트리거로 슈퍼유저도 수정·삭제 불가.
- 지원 SQL에는 `delete from`/`truncate`/`drop table`이 없고, `execute`는 `pg_get_functiondef` 제자리 패치 4곳뿐(호출자 입력 동적 SQL 없음). 롤백의 `drop table`은 데이터 보호 가드(raise exception) 뒤에만.
- 한 트랜잭션(begin…commit): 위치 불일치·검증 실패 시 CHECK/컬럼/트리거 포함 전부 롤백.

### 10-3. 외부 PG 검증 의존성 분석
| 동작 | DB가 검증하는 것 | 서버(앱)가 반드시 검증해야 하는 것 (DB는 검증 불가) | 현재 상태 |
|---|---|---|---|
| 승인 | provider·상태·선점·금액·TID 유일·**서버 검증 승인 기록 일치**·결제 기록 provider/TID/금액 | 승인 응답 서명(`sha256(TID+MID+Amt+Key)`)·MID·Moid·금액, NextAppURL 허용 호스트 | 코드 구현·테스트 PASS(라우트 미연결) |
| 망취소 | 승인 기록이 있으면 취소 기록 없이는 release 불가 | 망취소 응답 코드 2001, 거래번호 | 구현 PASS / 응답 규격 일부 BLOCKED |
| 승인 후 취소(환불) | 서버 검증 승인에 대한 취소 기록(2인 승인 또는 응답 요약값)이 있어야 내부 환불 | **취소 응답 서명(`sha256(TID+MID+CancelAmt+Key)`) 검증**·코드 2001/2211 | **BLOCKED**: 서명 검증 코드는 아직 없음(함수 `cancelResponse`는 있음). 활성화 전 필수 |
| 거래 조회 | — | 결과 불명 시 PG 상태 재조회 | **BLOCKED**(공식 조회 API 미확인) |
| 웹훅 | — | 문서상 서명 없음 → 힌트 전용 | 상태 변경 없음(분류만) |
→ **DB 계층은 "서버가 검증했다는 기록"을 추가 전용으로 강제**하지만, 그 기록 자체의 진위는 서버 코드가 보장해야 한다. 서비스 롤 키가 유출되면 기록을 위조할 수 있다(가장 큰 잔여 위험, 키 관리/접근 통제 영역).

### 10-4. "스키마만 준비"와 "결제 활성화"의 분리
| 단계 | 상태 | 동작 |
|---|---|---|
| **A. 스키마만 적용** (SQL 3개 적용, 앱 코드는 현재 상태) | 지금 목표 | 앱은 NICEPAY 주문을 만들지 않는다(Factory `nicepay`는 비활성, checkout은 `NICEPAY_CHECKOUT_ACTIVATED=false`로 주문 생성 전 차단). 기존 Toss/PortOne/Mock/직접결제 동작·기록은 변하지 않음(PGlite C·C2·U1: 적용 전후 Toss 완료 3건 데이터 동일, 환불 경로 동일). DB상 클라이언트가 `payment_provider='nicepay'` 주문을 직접 INSERT할 수는 있으나 **휴면 주문**이다: 서버 전용 RPC 없이는 approving/paid/done 불가, `fulfill_order` 거부, 승인 기록 없이는 확정 불가, 회원이 pending→cancelled만 가능 |
| **B. 코드 준비** (라우트·운영 도구 구현, 플래그 OFF) | 미착수 | 아래 10-5 BLOCKED 항목 |
| **C. 활성화** | 계약·MID/KEY·카드사 심사 후 | `NICEPAY_CHECKOUT_ACTIVATED` 해제(리뷰된 코드 변경) + 환경변수 + `PG_CHECKOUT_ENABLED` 정책 결정 |

### 10-5. NICEPAY 결제 활성화 전 반드시 보완할 코드 (PASS / BLOCKED)
| 항목 | 상태 |
|---|---|
| 서명 계산·비교, 허용 URL, 로그 redact, 승인/망취소 호출 모듈 | **PASS**(오프라인) |
| 라이프사이클(게이트·선점 fencing·승인 기록·확정·보상·검토 대기) + DB 어댑터 | **PASS**(오프라인, 라우트 미연결) |
| Mock/disabled fail-closed, 직접결제 fallback, `handleRefund` NICEPAY 501 | **PASS** |
| ReturnURL 수신 라우트(+deps 조립: creds·fetch·`gateAllows`·로그) | **BLOCKED** |
| 결제창 호출용 SignData 서버 발급 엔드포인트, 결제창 SDK 연동(goPay), 앱(Capacitor) 복귀 | **BLOCKED**(MID/KEY·SDK 규격) |
| 웹훅 수신 라우트(힌트 전용 분류 → 검토 큐) | **BLOCKED** |
| 취소 API 연동 + **취소 응답 서명 검증 코드** + `handleRefund` NICEPAY 분기(취소→검증→`nicepay_record_pg_cancel`→`refund_membership_server`) | **BLOCKED** |
| 운영자 도구(`resolve_review`/`confirm_reviewed`/`record_pg_cancel(admin_console)`): **처리자·승인자를 인증된 서로 다른 관리자 계정에서 가져오는 구현**(DB는 문자열만 받음) | **BLOCKED** |
| stale claim 만료 크론 + 검토 큐 알림 | **BLOCKED** |
| 복귀 토큰 라우트의 provider 일반화(현재 `toss` 전제) | **BLOCKED** |
| 거래 조회 API 기반 자동 복구 | **BLOCKED**(공식 규격 미확인) |
| `PG_CHECKOUT_ENABLED`/심사용 override 정책, 약관·환불·개인정보 문구 PG명 교체 | **BLOCKED**(승인 필요) |

### 10-6. 권장 적용 순서 (최종)
0. 읽기 전용: `preflight_nicepay_patch_targets_20261016.sql` — 모든 `*_ok` true
1. `fix_refund_block_all_pg_providers_20261016.sql`
2. `add_nicepay_provider_support_20261016.sql`
3. `fix_create_order_secure_allow_nicepay_20261016.sql`
4. 읽기 전용: `verify_fix_refund_block_all_pg_providers_20261016.sql`, `verify_add_nicepay_provider_support_20261016.sql` — 모두 true
롤백(역순): `rollback_fix_create_order_secure_allow_nicepay_20261016.sql` → `rollback_add_nicepay_provider_support_20261016.sql` → `rollback_fix_refund_block_all_pg_providers_20261016.sql`. 롤백은 nicepay 주문/승인·취소·감사 기록이 하나라도 있으면 중단(데이터·증거 보호).

## 11. `nicepay_release_order` 동시성 수정 (2026-10-16)

**발견**: 이전 `nicepay_release_order`는 승인 기록(`nicepay_pg_approvals`)을 먼저 조회한 뒤 `update orders`를 했다. READ COMMITTED에서 조회(기록 없음) 직후 다른 트랜잭션이 승인 기록을 저장·커밋하면, 이 함수의 `update`는 행 잠금 대기 후 그대로 진행해 **서버가 검증한 승인이 있는 선점을 취소 확인 없이 풀 수 있었다**(재결제 → 이중 청구 위험).

**수정**: ① 주문 행을 `FOR UPDATE`로 **먼저** 잠금(승인 기록 저장·확정·수동 해소·취소 기록 함수와 같은 잠금 순서 → 교착 없음) ② 잠금 후 provider/상태/claim_id/거래번호/검토 대기를 **재검증**, 하나라도 다르면 `false` ③ 같은 트랜잭션에서 승인·취소 기록 재확인, 취소가 확인되지 않은 승인 기록이 있으면 `false` ④ 그 뒤에만 갱신. 반대 방향(release가 먼저 끝난 뒤 승인 기록 저장)은 `nicepay_record_verified_approval`이 선점 불일치로 거부.
다른 함수 점검: `record_verified_approval`·`record_pg_cancel`·`resolve_review`·`confirm_nicepay_payment`·`confirm_reviewed`는 이미 주문 행을 먼저 잠근다(불변식 테스트 X1로 고정). `claim_order`/`mark_review`/`expire_stale_claims`는 기록 테이블을 읽지 않는 단일 `update`.

**검증 한계(정직하게)**: PGlite는 단일 세션이라 두 트랜잭션의 실제 인터리빙을 오프라인 테스트로 재현할 수 없다. 오프라인으로는 ⓐ 잠금 순서 불변식(구 구현은 검사에 걸림) ⓑ 같은 트랜잭션 내 승인 기록 직후 release 거부, 잠금 후 재검증 결과를 확인했다. **실제 2세션 경합 검증은 일회용 Postgres(로컬/브랜치 DB, 운영·공유 DEV 아님)에서 아래 절차로 적용 후 1회 확인**을 권장한다.

2세션 절차(psql 두 창, 모두 일회용 DB):
```
-- 준비: nicepay 주문 O를 claim(C 획득, status=approving), 서버 라이트 role로 진행
-- 세션 A
begin;
select nicepay_record_verified_approval('<O>', '<C>', 'TID-RACE-1', <금액>, repeat('a', 64));   -- 주문 행 잠금 보유, 아직 커밋 안 함
-- 세션 B (A가 열려 있는 동안)
select nicepay_release_order('<O>', '<C>', 'netcancel_confirmed');                              -- 주문 행 잠금 대기(블록)
-- 세션 A
commit;
-- 세션 B가 풀리며 반환값 확인: 기대값 f(false). 확인: select status from orders where id='<O>';  → approving
```
이전 구현에서는 B가 승인 기록을 못 본 채 `t`를 반환하고 상태가 pending으로 바뀐다.
