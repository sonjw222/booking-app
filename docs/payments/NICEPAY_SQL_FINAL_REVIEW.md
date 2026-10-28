# NICEPAY 운영 SQL 최종 검토 패키지 (NICEPAY_SQL_FINAL_REVIEW)

- 기준: 브랜치 `feat/nicepay-review-integrated-20261029`. 이전 검토 기준 커밋 `c1022febebdb48a66e9bb20ee4e91a60c862d8b2`(문서 `123f718`) 이후 **P2 의 accounts 보호 트리거를 INSERT 까지 확장**했고(§4-3), 증거를 영구 파일로 교체했다. 이 문서의 SQL 원문·해시는 수정 후 파일 기준이다.
- 이 문서는 아래 6개 SQL 파일을 **원문 그대로(생략·수정 없음)** 묶었다. 각 파일의 SHA-256 을 적어 두었으니 저장소 파일과 대조할 수 있다.
- **어떤 SQL 도 운영·공유 DEV 에서 실행하지 않았다.** 운영은 읽기 전용(SELECT)으로만 조회했고, 파괴·실패 주입 시험은 모두 로컬 일회용 Supabase 에서만 했다. 기존 SQL·앱 코드는 이 작업에서 수정하지 않았다.
- 작성 시점의 운영 상태(읽기 전용 조회): 게이트 `mode=off`, 센터 7(내부 4)·상품 62·수업 59·주문 22·수강권 24·예약 19·계정 22, `pg_checkout_override=true` 계정 1(토스 심사 계정), 분리 SQL 미적용. P0 함수 정의 해시 3/3 일치·P0b 7/7 true(`docs/payments/NICEPAY_PREFLIGHT_20261029.md`).

> **2026-10-30 독립 리뷰 반영(이 문서의 SQL 전문·해시는 수정 후 기준)** — ① 센터·상품·수강권 센터 **일치** 검사 추가(`nicepay_review_guard_center`: 주문·수강권·장바구니·구매신청은 행의 `center_id` ↔ 상품의 실제 센터, 예약은 수업 ↔ 수강권 센터 — 둘 다 NULL 이 아닐 때만 비교해 NULL 허용 흐름 유지) ② P2b 게이트가 `reviewer` 모드에서 전용 권한뿐 아니라 **주문의 실제 센터·상품이 심사 대상**인지도 확인(`nicepay_order_is_review_target`) ③ P2b 롤백은 게이트 mode 가 `off` 가 아니면 중단, P2 롤백은 P2b 가 남아 있으면 중단 ④ P2·P2b 는 **실행 시점에** 대상 함수 정의 해시를 확인해 예상과 다르면 덮어쓰지 않고 중단 ⑤ 운영자 전용 플래그 트리거의 `auth.uid() is null` 허용을 `nicepay_is_client_request()`(JWT sub 가 없어도 `anon`/`authenticated` 롤이면 클라이언트로 취급)로 보강 ⑥ 심사 종료 SQL 은 선점·거래·검토 흔적이 없는 대기 주문만 취소. 증거: `docs/qa/nicepay-p2-review-fix-20261030/`.

> **2026-10-30 후속 수정(2차 독립 검토 반영)** — ① **P2 롤백 결함 수정**: 롤백이 남겨 두는 accounts 보호 트리거(`enforce_nicepay_review_access_admin_only`)가 호출하는 `nicepay_is_client_request()` 를 삭제해, 롤백 뒤 권한 컬럼을 건드리는 모든 INSERT/UPDATE(관리자·서버·SQL Editor 포함)가 `function nicepay_is_client_request() does not exist` 로 실패했다(로컬 재현 20/26). 이제 의존 함수를 유지한다(26/26). 기존 롤백 시험이 놓친 이유: 삭제 목록을 기준으로 잔여 함수 수만 셌고(순환 기대값), plpgsql 은 함수 본문의 호출을 늦게 해석해 DROP 이 오류 없이 통과하며, 트리거가 권한 값이 바뀔 때만 헬퍼를 호출해 일반 가입·수정은 계속 성공했고, accounts 보호 시험은 적용 상태에서만 돌렸다. ② **P2b 심사 대상 조건**: 상품 NULL 제외, 승인·비내부 심사 센터, 판매 중(`is_active`·`is_on_sale`) 상품만 — 판매 중지·비활성·닫힌 센터의 대기 주문은 reviewer 모드에서 승인 선점 불가(되돌리면 다시 가능). ③ **P2b 롤백**: mode=off 에 더해 승인 선점 중(`approving`) NICEPAY 주문이 있으면 중단. ④ **운영 현황 정정**: `trg_accounts_insert_privileged_columns` 는 PR #245 로 운영에 이미 적용됨(§8). 증거: `docs/qa/nicepay-rollback-final-20261030/`.

> **2026-10-30 심사 종료·롤백 안전장치 보완(3차 검토 반영)** — 기존 센터 조회 정책(`승인된 센터 조회`/`상품 조회`/`승인된 센터 수업 조회`)은 **내부(`is_internal`) 센터라도 `center_members` 에 등록된 회원(`my_member_center_ids()`)과 매니저에게 조회를 허용**한다. 그래서 심사 종료 SQL 이 센터를 `is_internal=true` 로 닫아도 심사 센터에 일반 회원이 등록돼 있으면, P2 분리 정책을 롤백하는 순간 그 회원에게 심사 센터·상품·수업이 보였다(로컬 재현: 일반회원A `0/0/0/0/0` → `1/3/1/3/0`, 증거 `docs/qa/nicepay-rollback-final-20261030/memberExposure-BEFORE.json`). 이제 **P2 롤백이 정책 제거 전후로 계정별 실제 가시성(JWT 컨텍스트)을 측정해, 노출이 늘어나는 계정이 하나라도 있으면 전체를 롤백하고 중단**한다(`memberExposure-AFTER.json` 22/22). 관계 데이터(회원·프로필·주문·수강권·예약)는 자동으로 지우거나 고치지 않는다. 종료 SQL 순서는 게이트 off → approving 확인 → 권한 해제 → 센터 비공개 → 대기 주문 정리 → 노출 관계 확인으로 정리했고, 읽기 전용 `check_nicepay_review_rollback_readiness_20261030.sql` 을 추가했다.

## 1. 결론(독립 재확인 요약)
| 질문 | 결론 | 근거(§4) |
|---|---|---|
| 기존 운영 센터·상품·주문 데이터를 바꾸는가 | **아니오** — 어떤 SQL 에도 기존 테이블 행을 INSERT/UPDATE/DELETE 하는 문장이 없다. 컬럼 2개 추가(기본값 false)와 객체 추가·함수 교체뿐 | 정적 검사 + 로컬 데이터 지문 동일 |
| 기존 토스 심사 계정에 영향이 있는가 | **없음** — P2 실행 코드는 `pg_checkout_override` 를 참조하지 않고, P2b 는 NICEPAY 게이트 함수 2개 안의 문자열만 바꾼다. 토스 계정의 센터 접근·`pg_checkout_override` 값 불변 | 정적 검사 + 로컬 매트릭스 |
| NICEPAY 전용 권한이 분리되는가 | **예** — `accounts.nicepay_review_access`(운영자만 지정: **INSERT·UPDATE·upsert·삭제 후 재생성 모두 보호**)만 심사관 판정·게이트에 쓰인다. 토스 심사 계정은 NICEPAY 게이트에서 거부 | §4-3(실제 인증·REST 26/26) + 로컬 게이트 매트릭스 |
| 기존 운영 함수 교체의 영향 | **행동 불변(심사 센터·심사관 없을 때)** — 교체 3개 모두 현재 운영 정의(해시 일치) + 조건 1개 추가이고, 모든 기존 센터에서 추가 조건은 항상 참. 권한(ACL)·SECURITY DEFINER·search_path 동일 | §4-4 |
| 실행 도중 실패하면 원자적으로 롤백되는가 | **예** — 두 SQL 모두 `BEGIN…COMMIT` 단일 트랜잭션. 실패 주입(P2 중간·끝, P2b 두 번째 함수) 시 잔여물 0, 기존 함수 정의 불변(로컬) | §4-5 |
| 검증 실패 시 중단 조건 | §5 표 — 기대값 하나라도 다르면 **다음 단계(P2b·시드·심사관 지정)로 진행하지 않고 롤백 검토** | §5 |
| 심사 종료 후 센터 비공개 | **가능·검증됨** — `close_nicepay_review_20261029.sql` 후 익명/일반 직접 조회 0, 이후에만 P2 롤백 허용 | §6 |

## 2. 파일 목록과 실행 순서
| 순서 | 구분 | 파일 | 줄 수 | SHA-256(앞 16자) |
|---|---|---|---|---|
| 1 | P2 | `add_nicepay_review_center_isolation_20261028.sql` | 352 | `54f3a1241376505a…` |
| 2 | V-P2 | `verify_add_nicepay_review_center_isolation_20261028.sql` | 34 | `e442f3ff53be4cff…` |
| 3 | P2b | `fix_nicepay_gate_reviewer_flag_20261029.sql` | 72 | `46bb12c7fe752d48…` |
| 4 | V-P2b | `verify_fix_nicepay_gate_reviewer_flag_20261029.sql` | 15 | `4c5f5f3dc1aa35be…` |
| 롤백-1 | RB-P2b | `rollback_fix_nicepay_gate_reviewer_flag_20261029.sql` | 44 | `b2b55dc804bc8878…` |
| 롤백-2 | RB-P2 | `rollback_add_nicepay_review_center_isolation_20261028.sql` | 250 | `b56d97c4949a364d…` |
| 심사 종료 | 부록 A | `close_nicepay_review_20261029.sql` | 43 | `34386b16c7cf423f…` |
(전체 SHA-256 는 각 SQL 전문 절 머리에 있다.) 사전 점검(P0)·시드(P3)·심사관 지정은 이 6개 파일에 포함되지 않는다: P0 = `preflight_nicepay_review_center_isolation_20261028.sql`(읽기 전용, 운영에서 이미 실행·통과), P3 = `seed_nicepay_review_center_20261028.sql`(별도 승인·값 확정 필요), 심사관 지정 = `update accounts set nicepay_review_access = true where auth_id = (select id from auth.users where email = 'sonjw222@naver.com');`(별도 승인).

**순서 규칙**: P2 → V-P2(통과 확인) → P2b → V-P2b(통과 확인) → (별도 승인) 시드 → (별도 승인) 심사관 지정. 심사관 지정은 반드시 P2b 이후(P2b 전에는 게이트가 토스 계정 기준이라 NICEPAY 심사관이 결제 게이트를 통과하지 못한다). P2b 는 P2 의 컬럼이 없으면 스스로 중단한다. **롤백 순서는 반대**: 심사 센터가 있으면 먼저 닫기 → RB-P2b → RB-P2.

## 3. 각 SQL 의 적용 효과와 영향받는 기존 객체
### P2 — `add_nicepay_review_center_isolation_20261028.sql`
- **추가(신규)**: 컬럼 2(`centers.is_nicepay_review`, `accounts.nicepay_review_access`, 둘 다 `not null default false`), 함수 8(`nicepay_is_client_request`, `nicepay_is_reviewer`, `nicepay_review_center_allowed`, `nicepay_review_center_member_allowed`, `nicepay_class_has_my_reservation`, `nicepay_review_guard_center`, `enforce_center_nicepay_review_admin_only`, `enforce_nicepay_review_access_admin_only`), 정책 4(centers/classes/products 제한 정책 3 + classes 허용 정책 1), 트리거 12(accounts 1·centers 1·orders/memberships/cart_items/purchase_requests 각 INSERT·UPDATE 2 = 8·reservations INSERT·UPDATE 2).
- **교체(기존 함수, 운영 정의 해시 일치 확인됨)**: `center_rows_visible`(기존 조건 5개를 괄호로 묶고 `AND nicepay_review_center_allowed(...)`), `fetch_public_storefront_products`·`fetch_purchasable_products`(각 `where` 에 1줄 추가), `fetch_public_storefront_product_periods`(운영에는 없음 → **새로 생성**하고 함수 주석에 생성 표식을 남김).
- **기존 정책은 대체하지 않는다**: 기존 허용 정책("승인된 센터 조회" 등)은 그대로 두고 제한(restrictive) 정책을 겹친다.
- **효과**: 심사 센터(`is_nicepay_review=true`)는 NICEPAY 심사관·해당 센터 매니저·플랫폼 관리자에게만 보이고, NICEPAY 심사관에게는 심사 센터만 보인다(관리 화면용 매니저 읽기 예외는 유지). 구매·예약·수강권·장바구니·구매신청은 행이 가리키는 모든 센터(center_id·상품의 실제 센터·수업·수강권)를 트리거가 검사하고, 센터↔상품(예약은 수업↔수강권)이 서로 다른 센터를 가리키면 운영 센터끼리여도 거부한다(NULL 이 있는 기존 흐름은 비교에서 제외). 시작 시 3개 함수의 현재 정의 해시가 예상과 다르면 중단한다. 현재 운영에는 심사 센터도 심사관도 없으므로 **적용 직후 사용자에게 보이는 변화는 없다.**
### P2b — `fix_nicepay_gate_reviewer_flag_20261029.sql`
- **교체(기존 함수, 제자리 치환)**: `orders_guard_nicepay_create()`(코드 1곳), `nicepay_claim_order(uuid)`(코드 1곳+주석 1곳) 안의 `pg_checkout_override` → `nicepay_review_access and nicepay_order_is_review_target(센터, 상품)`. 정의 전체를 다시 쓰지 않고 운영의 현재 정의에서 문자열만 바꾼다(현재 정의 해시가 "적용 전 운영 정의"도 "적용본"도 아니면 중단, 치환 위치가 정확히 1곳이 아니면 중단, 치환 후 해시가 기대값과 다르면 전체 롤백, 이미 적용본이면 건너뜀=멱등). 보조 함수 `nicepay_order_is_review_target(uuid,uuid)` 1개 신규(PUBLIC/anon/authenticated 실행 불가): 센터가 승인·비내부 심사 센터이고 상품이 NULL 이 아니며 그 센터의 판매 중 상품일 때만 참.
- **효과**: 게이트 mode 가 `reviewer` 일 때 NICEPAY 주문 생성·승인 선점을 전용 권한 계정만 통과. **현재 mode=off 이므로 적용 직후 동작 차이 없음.**
### 검증·롤백
- V-P2: 컬럼 2·함수 8·제한 정책 3·허용 정책 1·트리거 12·목록 RPC 3 교체·`center_rows_visible` 교체·PUBLIC 실행 불가 4 + 기존 센터/상품 수 + 심사 센터/심사관/토스 override 계정 수. V-P2b: 두 함수가 새 플래그·심사 대상 확인을 쓰고 옛 플래그는 안 보는지, 정의 해시가 기대값인지, 보조 함수가 PUBLIC/authenticated 에 닫혀 있는지.
- RB-P2b: 게이트 mode 가 off 가 아니거나 승인 선점 중(approving) NICEPAY 주문이 있으면 중단 → 두 함수 역치환(결과 해시가 적용 전 운영 정의와 같은지 확인) → 보조 함수 삭제. RB-P2: 정책·트리거·신규 함수 삭제, 기존 함수 3개를 적용 전 정의로 복원, 기간 RPC 는 P2 가 만든 것이면 삭제(함수 주석 표식)·이전부터 있었으면 복원. **컬럼 2개와 `accounts` 보호 트리거(및 그 트리거가 호출하는 `enforce_nicepay_review_access_admin_only`·`nicepay_is_client_request`)는 데이터 보존을 위해 남긴다.** P2b 가 남아 있거나 공개 가능한 심사 센터(승인·비내부)가 있으면 아무것도 바꾸지 않고 중단.

## 4. 독립 재확인
### 4-1. 기존 운영 센터·상품·주문 데이터 변경 여부 — 변경 없음
- 정적: 6개 파일의 실행 코드(주석 제외)에 대해 `insert into / update / delete from / truncate / drop table / drop column` 을 검사 — **기존 업무 테이블을 대상으로 하는 DML 없음**. 유일한 `ALTER TABLE` 은 `add column if not exists … not null default false` 2건(PostgreSQL 11+ 에서 상수 기본값은 행을 다시 쓰지 않는 메타데이터 변경). `drop` 은 P2/RB 가 자기가 만든 정책·트리거·함수만 지운다.
- 동적(로컬, 운영과 같은 함수 정의에서 시작): 센터·상품·수업·주문·수강권·예약·계정·매니저 관계의 지문이 **P2+P2b 적용 전후 동일**(`98e1236c…` = `98e1236c…`), 시드 후에도 심사 센터 행 외 불변, 닫기·롤백 후에도 동일.
- 주의: 운영 `accounts`·`centers` 에 컬럼이 추가되므로 `select *` 결과 열이 2개 늘어난다(앱은 명시 컬럼 조회라 영향 없음, 단 컬럼 전체 덤프/동기화 도구가 있다면 확인).
### 4-2. 기존 토스 심사 계정 영향 — 없음
- P2 실행 코드에 `pg_checkout_override` 참조 없음(주석·COMMENT 문구만 — 정적 계약 테스트가 강제). P2b 는 NICEPAY 전용 게이트 함수 2개만 건드린다(토스 결제 경로 아님).
- 운영에는 `pg_checkout_override=true` 계정이 1개(토스 심사 계정, 회원). 로컬 매트릭스(토스 심사관 페르소나): 센터 목록·운영/토스 센터 주문 가능은 **변경 없음**, 심사 센터 불가, NICEPAY 게이트 거부.
- 부수 효과 한 가지(의도된 것): 게이트가 토스 플래그를 더는 보지 않으므로, P2b 이후 `mode=reviewer` 에서 토스 심사 계정은 NICEPAY 주문을 만들 수 없다(이전엔 운영 센터 상품으로도 가능했던 구멍).
### 4-3. NICEPAY 전용 권한 분리 (INSERT 보호 보완 포함)
- 판정 함수 `nicepay_is_reviewer()` 는 `accounts.nicepay_review_access` 만 본다(`my_account_id()` 기준, 이메일 비사용). 게이트: P2b 후 두 함수 모두 새 플래그 사용·옛 플래그 미사용. 게이트 매트릭스(로컬): reviewer 모드에서 일반 회원·토스 심사관 거부, NICEPAY 심사관은 심사 센터 상품만 통과.
- **보완(이번 수정)**: 이전 P2 의 보호 트리거는 `BEFORE UPDATE` 전용이라, "본인 계정 생성" RLS 정책(`auth_id = auth.uid()` 만 확인, 컬럼 값 미확인)과 authenticated 의 전체 컬럼 INSERT 권한 때문에 **가입 시점에 `nicepay_review_access=true` 로 계정을 만들 수 있었다**(로컬에서 실제 인증·REST 로 재현). 이제 트리거는 `BEFORE INSERT OR UPDATE` 이고, 인증 사용자(auth.uid() 있음)가 플랫폼 관리자가 아니면 true 지정을 거부한다. 서버(service_role)·SQL Editor(auth.uid() is null)·플랫폼 관리자는 통과.
- **검증 구분**
  - *실제 인증·REST(Auth signUp → 앱 가입 화면 `app/login/page.tsx` 와 같은 페이로드로 PostgREST INSERT)*: 정상 가입 성공(권한 false), 가입 시 true 지정 거부(행 미생성), 가입 시 false 명시 성공, 기존 계정의 자기 UPDATE 거부, upsert(신규 true 거부 / 기존 행 ON CONFLICT DO UPDATE 로 true 거부 / 일반 갱신 성공), 본인 계정 삭제 후 true 재생성 거부·정상 재생성 성공, 플랫폼 관리자(본인 계정) 부여·해제 성공, 서버(service_role) 생성·해제 성공, SQL Editor 경로 부여 성공, 기존 보호(`pg_checkout_override`·`is_platform_admin` 자기 UPDATE) 유지.
  - *DB 최소 재현(psql: `set local role authenticated` + JWT claims)*: INSERT(true) 거부, INSERT(false)·기본값 성공.
  - 결과: **수정 전 15/25(결함 재현: R2·R5·R7·D1 이 CREATED), 수정 후 26/26 PASS** — `docs/qa/nicepay-sql-final-review-20261030/accounts-flag-guard-BEFORE-fix.json`, `accounts-flag-guard-AFTER-fix.json`(스크립트 `scripts/isolated/nicepayReview/accountsFlagGuard.mjs`).
  - 브라우저 가입 화면 자체(전화 OTP 단계 포함)는 이번에 시험하지 않았다 — 앱 코드가 보내는 INSERT 페이로드를 같은 REST 경로로 재현한 것까지다.
- 참고: 플랫폼 관리자가 *다른* 계정을 REST 로 수정하는 경로는 기존 RLS("본인 계정 수정")가 0행 처리한다(이번 변경과 무관). 부여는 SQL Editor·서버 경로로 한다.
### 4-4. 기존 운영 함수 교체의 영향
| 함수 | 변경 | 권한/속성 | 영향 |
|---|---|---|---|
| `center_rows_visible` | 기존 5개 조건을 `( … ) AND nicepay_review_center_allowed(p_center_id)` | 운영 ACL: postgres·anon·authenticated·service_role 실행(`create or replace` 는 ACL 유지), SECURITY DEFINER, `search_path=public` 동일 | 이 함수를 쓰는 9개 테이블 정책(휴무일·리뷰·커뮤니티·룸·상담채널·설정·센터항목·센터후기·진도카테고리)과 `class/product_rows_visible`. 심사 센터·심사관이 없으면 추가 조건이 항상 참 → **결과 동일** |
| `fetch_public_storefront_products` | `where` 1줄 추가 | 파일의 `revoke…from public; grant…to anon, authenticated` = 운영 ACL(postgres·anon·authenticated)과 동일 | 심사 센터가 없으면 결과 동일 |
| `fetch_purchasable_products` | `where` 1줄 추가 | `revoke…from public, anon; grant…to authenticated, service_role` = 운영 ACL 과 동일 | 동일 |
| `fetch_public_storefront_product_periods` | 운영에 없음 → 신규 | anon·authenticated 실행 | 앱이 이 RPC 를 선택적으로 사용(없으면 공통 안내문) |
| `orders_guard_nicepay_create`, `nicepay_claim_order` (P2b) | 문자열 치환 | `create or replace` 라 ACL(postgres만 / postgres+service_role)·SECURITY DEFINER·search_path 유지 | mode=off 이므로 현재 동작 차이 없음 |
- 새 INSERT/UPDATE 트리거가 운영의 `orders`·`memberships`·`reservations` 에 추가된다. 기존 트리거(`orders_guard_*`, `orders_force_server_fields_on_insert` 등)는 그대로이며 이름이 달라 공존한다. 서버/service_role(`auth.uid() is null`)은 통과. 일반 회원 흐름은 센터가 일반 센터이면 판정이 항상 참이라 통과(로컬 매트릭스: 일반 회원 운영 상품 주문 정상).
- 잠금·성능: `ALTER TABLE accounts/centers` 와 트리거 생성은 해당 테이블에 짧은 배타 잠금이 필요하다. 운영 규모(주문 22·수강권 24·예약 19·수업 59·상품 62)에서는 순간적이지만 **사용량이 적은 시간대에 실행**하고, 필요하면 실행 세션 앞에 `set lock_timeout = '5s';` 를 두는 것을 권장(파일은 수정하지 않음).
### 4-5. 실행 도중 실패 시 원자성 — 로컬 실패 주입 결과
두 SQL 모두 `BEGIN; … COMMIT;` 한 트랜잭션이다. PostgreSQL 은 DDL 도 트랜잭션이므로 중간 오류가 나면 이후 문장은 "트랜잭션 중단" 상태로 모두 실패하고 마지막 `COMMIT` 은 롤백으로 처리된다. `ON_ERROR_STOP` 없이(편집기처럼 끝까지 흘려보내는 방식으로) 실행해 확인:
```
=== 1. 원자성·멱등 (psql 을 ON_ERROR_STOP 없이 실행 — 편집기처럼 끝까지 흘려보내는 방식) ===
[기준] 기존 함수 5개 정의 해시 기록. 잔여물(컬럼/함수/트리거/정책) = 1/1/0/0 — 컬럼 1(is_nicepay_review: 롤백이 데이터 보존용으로 남김)·함수 1(accounts 보호 함수: 같은 이유로 남김)이 기준값
[T1 P2 실패 주입:mid] ERROR 13회 → 잔여물 1/1/0/0 / 기준(1/1/0/0)과 동일: YES / 기존 함수 정의 해시 동일: YES
[T1 P2 실패 주입:late] ERROR 1회 → 잔여물 1/1/0/0 / 기준(1/1/0/0)과 동일: YES / 기존 함수 정의 해시 동일: YES
[T2 P2b 를 P2 없이 실행] nicepay_review_access 가 없어요 — add_nicepay_review_center_isolation_20261028.sql 을 → 기존 함수 정의 해시 동일: YES
[T3 P2 정상 적용] ERROR 0회, 잔여물 2/8/12/4 (기대 2/8/12/4)
[T3 검증 SQL 1번 쿼리]
   columns_must_be_2|2
   new_functions_must_be_8|8
   restrictive_policies_must_be_3|3
   own_reservation_policy_must_be_1|1
   triggers_must_be_12|12
   list_rpcs_replaced_must_be_3|3
   center_rows_visible_replaced_must_be_true|t
   replaced_definitions_match_expected_must_be_true|t
[T4 P2b 두 번째 함수 실패 주입] 가 없어요 — NICEPAY 게이트/지원 SQL 이 적용돼 있어야 해요 → 첫 번째 함수까지 원복(정의 해시 동일): YES
[T5 P2b 정상] ERROR 0회
   nicepay_claim_order|t|t|f|t
   orders_guard_nicepay_create|t|t|f|t
   t|t|t|off
[T6 재적용(멱등)] P2 재실행 후 P2b 재실행: 2개 함수 '건너뜀', 정의 변화 없음: YES, 잔여물 2/8/12/4 (기대 2/8/12/4)
[T7 검증 실패 조건 시연] 트리거 1개를 일부러 지우면:
   triggers_must_be_12|11
   (P2 재적용으로 복구) triggers_must_be_12|12
```
영구 증거 파일: `docs/qa/nicepay-rollback-final-20261030/atomicity-and-idempotency.txt` (재현: `scripts/isolated/nicepayReview/finalReview.sh <디렉터리>`)
- 결과: P2 중간(함수 생성 직전)·끝(COMMIT 직전) 실패 주입 시 잔여물이 시작 기준과 동일하고(P2 가 만든 컬럼·함수·트리거·정책이 하나도 남지 않음) 기존 함수 5개의 정의 해시도 불변. P2b 는 컬럼이 없는 상태(P2 미적용)에서 실행하면 즉시 중단하고, 두 번째 함수 처리 중 실패해도 첫 번째 함수까지 원복. 정상 적용·재적용(멱등)은 변화 없음. (롤백이 데이터 보존용으로 남기는 `is_nicepay_review` 컬럼·accounts 보호 함수는 기준값에 포함.)
- 한계: 이 보장은 **스크립트 전체가 한 번의 요청/세션으로 실행될 때**의 PostgreSQL 동작이다. 편집기·도구가 문장을 쪼개 따로 실행하면 일부만 적용될 수 있으므로, 파일 전체를 한 번에 실행하고 반드시 실행 후 검증을 확인한다(편집기별 동작은 이 환경에서 확인하지 못했다).
### 4-6. 실행 후 검증 실패 시 중단 조건
§5 참조. 하나라도 기대값과 다르면 **다음 단계로 진행하지 않는다**.
### 4-7. 심사 종료 후 센터 비공개
§6 참조.

## 5. 중단(STOP) 조건 — 실행 후 검증 기대값
| 단계 | 검증 | 기대값 | 다르면 |
|---|---|---|---|
| P2 직후 | V-P2 1번 쿼리 | `columns_must_be_2=2`, `new_functions_must_be_8=8`, `restrictive_policies_must_be_3=3`, `own_reservation_policy_must_be_1=1`, `triggers_must_be_12=12`, `list_rpcs_replaced_must_be_3=3`, `center_rows_visible_replaced_must_be_true=t`, `helpers_executable_by_public_must_be_0=0`, `replaced_definitions_match_expected_must_be_true=t` | **STOP** — P2b·시드·심사관 지정 금지, 원인 확인 후 RB-P2 검토 |
| P2 직후 | V-P2 2번 쿼리 | `existing_centers`·`existing_products` 가 적용 전에 기록한 값과 같음(현재 운영 7 / 62 에서 심사 센터 0) | STOP — 기존 데이터 변경 의심 |
| P2 직후 | V-P2 3번 | `review_centers=0`, `nicepay_reviewer_accounts=0`, `toss_override_accounts_unchanged=1` | STOP |
| P2b 직후 | V-P2b | 두 행 모두 `uses_new_flag=t`, `checks_review_target=t`, `still_uses_old_flag_must_be_false=f`, `definition_matches_expected=t`; 보조 함수 `helper_exists=t`·PUBLIC/authenticated 실행 불가 | STOP — RB-P2b |
| 적용 직후 앱 | 일반 회원 로그인 후 홈·상품·구매 화면 | 평소와 동일, 오류 없음 | STOP — 롤백 검토 |
| 시드 후(별도 승인) | V-P2 3번 | `review_centers=1`; 익명/일반 계정에서 심사 센터·상품 0건 | 일반에 보이면 즉시 `update centers set is_internal = true where is_nicepay_review;` 후 원인 확인 |
| 심사관 지정 후(별도 승인) | V-P2 3번 | `nicepay_reviewer_accounts=1`, `toss_override_accounts_unchanged=1` | 즉시 지정 해제(`= false`) |

## 6. 롤백 순서와 NICEPAY 심사 종료
1. **심사 종료 절차** `close_nicepay_review_20261029.sql`(부록 A): ① 전용 권한 해제 ② 게이트 `off` ③ 심사 센터 `is_internal=true`(`centers.status` 는 보호 트리거 때문에 SQL Editor 로 변경 불가·플랫폼 관리자만 가능하므로 `is_internal` 사용) ④ 심사 센터의 **선점·거래·검토 흔적이 없는 대기(pending) 주문**만 취소(결제 진행 중 `approving`·완료 주문은 건드리지 않는다: 승인 선점은 `pending`→`approving` 전이이고 ②에서 게이트가 이미 off 라 새 선점이 막히며, 선점과 취소는 같은 행 잠금으로 직렬화된다). 기존 센터·상품·주문(결제 완료)·토스 계정 불변. 심사 중 생긴 주문·수강권은 보존(환불은 기존 절차).
1a. **심사 센터에 일반 회원 관계가 남아 있으면 P2 롤백은 중단된다**(위 머리말). 종료 후 `check_nicepay_review_rollback_readiness_20261030.sql` 과 종료 SQL 말미 확인 쿼리의 `center_member_rows`/`review_center_member_rows_block_p2_rollback_if_nonzero` 가 0 이 아니면 롤백하지 말고 P2 를 그대로 둔다(권장 — 일반 사용자에게는 이미 보이지 않는다). 롤백이 꼭 필요하면 관계 정리 방법(승인 필요)을 먼저 정한다.
2. **P2b 롤백 전제**: 게이트 mode 가 `off` 이고 승인 선점 중(`approving`) NICEPAY 주문이 없어야 한다(아니면 중단). **P2 롤백 전제**: P2b 가 먼저 롤백돼 있어야 하고, 공개 가능한 심사 센터(승인·비내부)가 있으면 RB-P2 가 중단한다 → 먼저 위 ③ 로 센터를 닫는다. 센터 하나를 닫으면 그 센터의 상품·수업 직접 조회도 같이 막힌다(기존 "상품 조회"/"승인된 센터 수업 조회" 정책이 승인된 비내부 센터만 허용).
3. **RB-P2b → RB-P2** 순서(P2b 가 P2 의 컬럼에 의존하므로 역순).
로컬 확인(2026-10-30 재실행 — 증거 파일은 `docs/qa/nicepay-rollback-final-20261030/rollback-and-close.txt`):
```
=== 2. 데이터 불변·롤백 순서·심사 종료 ===
[D1] 센터·상품·수업·주문·수강권·예약·계정·매니저 관계 지문 P2+P2b 적용 전 58545317883c33de0ce597decc2fc63c / 후 58545317883c33de0ce597decc2fc63c → 불변: YES
[A1] 시드 후(공개 상태) 익명 직접 조회(센터/상품/수업): 0/0/0 (기대 0/0/0 — 분리 정책 적용 중)
[R1] 공개 가능한 심사 센터가 있을 때 P2 롤백: 롤백 중단: P2b(NICEPAY 게이트 판별 패치)가 아직 적용돼 있어요. 먼저 rollback_fix_n → 정책 잔존 3 (기대 3)
[R2 심사 종료 SQL 출력] BEGIN UPDATE 0 UPDATE 1 UPDATE 1 UPDATE 0 COMMIT 
[R2b] 닫은 뒤 익명 직접 조회: 0/0/0 (기대 0/0/0), 기존 데이터 지문 변화 없음: YES
[R3] P2b 롤백 오류 0건 → 게이트 함수 nicepay_claim_order|f|f|t|f orders_guard_nicepay_create|f|f|t|f f|||off (옛 플래그 복원: 새 플래그 f / 옛 플래그 t)
[R4] P2 롤백 오류 0건 → 정책/보호트리거(정확한 이름)/신규 함수 잔여 0/1/0 (기대 0/1/0 — accounts 보호 트리거만 데이터 보존용으로 남음)
[R5] 롤백 후 익명 직접 조회: 0/0/0 (기대 0/0/0 — 센터가 닫혀 있어 분리 정책 없이도 비공개), 기존 데이터 지문 동일: YES
[R6] (대조) 분리 SQL 없이 공개 가능한 심사 센터를 두면 익명 직접 조회: 1/3/1 ← 롤백 안전장치가 막으려는 위험 상태
```
영구 증거 파일: `docs/qa/nicepay-rollback-final-20261030/rollback-and-close.txt`, 롤백 시나리오 19개: `docs/qa/nicepay-rollback-final-20261030/rollbackScenarios-AFTER.txt`
- 분리 SQL 없이 공개 가능한 심사 센터가 있으면 익명이 센터 1·상품 3 을 직접 조회(위험, A0) → P2 적용으로 0 → 센터를 닫으면 0 → 닫은 뒤 RB-P2b·RB-P2 후에도 0(A3). 롤백 안전장치 시나리오(P2b 잔존 시 중단·mode≠off 시 P2b 롤백 중단·공개 상태 중단, 기간 RPC 이전 존재 여부별 삭제/복원 4종) 19/19 통과(`scripts/isolated/nicepayReview/rollbackScenarios.mjs`).

## 7. 이 검토에서 확인하지 못한 것(솔직한 한계)
- 브라우저 가입 화면(전화 OTP 포함) 자체의 시험(§4-3: REST 재현까지).
- 운영 편집기/도구가 스크립트를 한 트랜잭션으로 실행하는지(로컬은 psql 단일 입력 기준).
- 운영에서의 실제 잠금 대기 시간(규모가 작아 영향이 적다고 판단하나 측정하지 않음).
- 운영 앱에서의 화면 확인(운영 로그인·구매 금지). 운영 함수 정의는 해시 3개로 확인했고 P2b 의 두 함수(`b2f340d8…`/`4cb7d4ec…`)는 이 변경 이후 실행 시점에 해시로 확인한다. P2·P2b 의 "적용본" 해시 상수는 로컬 PostgreSQL 17 에서 측정한 값이라 운영(17.6)에서 다르게 나오면 SQL 이 아무것도 바꾸지 않고 중단한다(안전 방향). 운영의 기존 트리거(`is_platform_admin`/`pg_checkout_override`/`merged_into`, accounts INSERT 보호)는 여전히 `auth.uid() is null` 패턴을 쓰며, PostgREST 로는 RLS 때문에 도달할 수 없지만 심층 방어로는 별도 검토 대상이다(이번 범위 밖).
- NICEPAY 쪽 사항(MID·키 계열·심사 전용 센터 허용·샌드박스)은 SQL 과 무관하며 회신 대기 중.

## 8. 범위 밖 선행 보안 발견 — **해결됨: PR #245 로 운영 적용 완료(이 패키지에서 다시 적용하지 않는다)**
위 INSERT 검증 중 **같은 원인의 기존 취약점**을 확인했다. `accounts` 의 **관리자 권한 보호 트리거 3개**(`trg_accounts_is_platform_admin_admin_only`·`trg_accounts_pg_checkout_override_admin_only`·`trg_accounts_merged_into_via_linking_only`)가 전부 **UPDATE 전용**이라, 계정 행이 아직 없는 인증 사용자가 가입(INSERT) 시점에 권한 컬럼을 직접 지정할 수 있다. (정정: 이전 표현의 `phone_verified` 는 컬럼이 아니라 `trg_accounts_phone_verified` 트리거(함수 `enforce_phone_verified_before_change`)를 가리킨 것인데, 이 트리거는 관리자 권한과 무관한 **전화번호 인증 보호**다 — 이미 있는 행의 `phone` 이 바뀔 때 최근 휴대폰 인증을 요구하는 UPDATE 트리거이며, INSERT 시점의 전화번호 인증은 "본인 계정 생성" RLS 정책의 `phone IS NULL OR _is_phone_recently_verified(phone)` 조건이 담당한다. 두 보호는 별개다. 이 취약점은 별도 보안 PR 로 분리돼 처리됐다.)
- 로컬 재현(실제 인증·REST): 가입 시 `is_platform_admin=true` → `is_platform_admin()=true`(**플랫폼 관리자 권한 획득**), `pg_checkout_override=true` → 생성됨, `merged_into=<다른 계정 id>` → `my_account_id()` 가 다른 계정 id 를 반환(**계정 사칭**).
- **운영 적용 현황(2026-10-30 읽기 전용 재확인)**: `trg_accounts_insert_privileged_columns`(함수 `enforce_accounts_insert_privileged_columns`, 정의 md5 `d56ce810f4e22a531087e56d0160fbc9`)가 **운영에 이미 존재**한다. PR #245 에서 `fix_accounts_insert_privileged_columns_20261030.sql`(SHA-256 `b8c77b4bbe669690e29d88f27cbd487d9b8dd975f63b5cc6995bae3929f619af`)을 운영에 적용(2026-10-27 16:21Z)했고 `main` 에 병합됐다. 이 SQL 을 로컬에 적용한 결과의 함수 정의 해시가 운영 값과 정확히 같음을 확인했다.
- **이전 초안과의 대조**: 이 브랜치에 있던 같은 이름의 초안(SHA-256 `ff356b4d…`)은 적용된 최종본과 로직 구성이 달랐다(초안: `auth.uid() is not null and not is_platform_admin()` 안에서 세 컬럼을 검사 / 적용본: `auth.uid() is null` 이면 통과, 그 외 `is_platform_admin`·`pg_checkout_override` 는 비관리자 거부, `merged_into` 는 연동 절차 예외). 혼동을 막기 위해 이 브랜치의 세 파일(`fix_/rollback_fix_/verify_fix_accounts_insert_privileged_columns_20261030.sql`)을 `origin/main` 의 적용본으로 교체했다.
- **따라서 운영 SQL 실행 순서에서 이 파일은 제외한다.** 불필요한 중복 적용 안내(P0 우선 검토 권고)를 제거했다. 로컬 격리 DB 는 운영과 같은 상태가 되도록 `setupLocal.sh` 가 이 SQL 을 먼저 적용한다(NICEPAY P2 의 `accounts.nicepay_review_access` 보호 트리거와 함께 동작).

## 9. SQL 전문(원문 그대로)

### 1. `add_nicepay_review_center_isolation_20261028.sql` — P2
- 설명: 센터 분리 본체 + 전용 권한 컬럼(accounts 보호 트리거는 INSERT·UPDATE)
- 줄 수: 352 · SHA-256: `54f3a1241376505ac08e5a26b56b92dc83b020b32b40e1aff8302376878262b1`

```sql
-- ============================================================
-- NICEPAY 카드사 심사 전용 센터 분리 (2026-10-28) — 검토용 초안, 로컬 격리 DB 에서만 실행·검증했다. 운영/공유 DEV 미실행.
--
-- 목적: NICEPAY 심사 전용 센터·수강권을 만들어도
--   · 일반 회원/비회원에게는 그 센터·수업·상품이 어떤 경로로도 보이지 않고(목록·직접 URL·RPC·구매·예약),
--   · NICEPAY 심사관 계정(accounts.nicepay_review_access = true — 신규 전용 권한. 기존 토스 심사용 pg_checkout_override 와 완전히 별개)에게는 심사 센터만 보이고 기존 운영 센터는 보이지 않게 한다.
--     기존 토스 심사 계정(pg_checkout_override)은 이 SQL 로 아무 영향도 받지 않는다.
--   기존 센터·상품·주문·수강권·예약 데이터는 읽기/수정/삭제하지 않는다(행 변경 0). 새 컬럼 2개(centers.is_nicepay_review, accounts.nicepay_review_access) + 함수 8개 + 정책 4개 + 트리거 12개 + 기존 함수 3~4개 정의 교체(center_rows_visible, 목록 RPC 2개, 선택적 기간 RPC).
--
-- 적용 순서(전제): ① (선택) add_public_storefront_product_periods_20261027.sql — 이 파일이 같은 함수를 조건 추가 버전으로 다시 만들므로 ①이 없어도 안전하다
--                   ② 이 파일  ③ (별도 승인, 데이터 생성) seed_nicepay_review_center_20261028.sql
-- 전제 객체: centers.is_internal(add_internal_qa_center_flag.sql),
--           my_account_id()/my_managed_center_ids()/is_platform_admin()/center_rows_visible()/product_rows_visible() — 운영에 없으면 아래 preflight 가 실패한다.
-- 되돌리기: rollback_add_nicepay_review_center_isolation_20261028.sql (기존 정의로 복원, 새 객체 삭제 — 컬럼은 데이터 보존을 위해 남긴다)
-- 확인(읽기 전용): verify_add_nicepay_review_center_isolation_20261028.sql
--
-- 접근 기준(요약)
--   · 플랫폼 관리자, 해당 센터의 활성 매니저: 항상 접근(기존 관리 기능 유지)
--   · 심사 센터(centers.is_nicepay_review): 심사관만. 그 외 회원/비회원은 불가
--   · 일반(운영) 센터: 심사관은 불가(심사관이 매니저/플랫폼 관리자인 센터는 예외), 그 외는 기존과 동일
--   · 기존 is_internal 규칙은 그대로 유지(추가로 AND 로 겹침 — 대체하지 않는다)
-- ============================================================
BEGIN;

-- 롤백이 이전 상태를 정확히 복원하도록, 기간 RPC 가 이 파일 적용 전에 있었는지 기록한다(없었으면 이 파일이 만든 것 → 롤백 시 삭제).
create temp table _nicepay_periods_existed on commit drop as select to_regprocedure('fetch_public_storefront_product_periods(uuid)') is not null as existed;

-- preflight 1: 전제 객체가 없으면 중단(부분 적용 방지)
do $$
begin
  if to_regprocedure('my_account_id()') is null or to_regprocedure('my_managed_center_ids()') is null
     or to_regprocedure('is_platform_admin()') is null or to_regprocedure('center_rows_visible(uuid)') is null
     or to_regprocedure('fetch_public_storefront_products(uuid)') is null or to_regprocedure('fetch_purchasable_products(uuid)') is null then
    raise exception 'NICEPAY 심사 분리: 전제 함수가 없습니다(운영 정의 확인 필요)';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='centers' and column_name='is_internal') then
    raise exception 'NICEPAY 심사 분리: centers.is_internal 이 없습니다';
  end if;
end $$;

-- preflight 2: 이 파일이 "통째로 다시 만드는" 기존 함수 3개의 현재 정의가 예상(적용 전 운영 정의 또는 이 파일을 이미 적용한 정의)과 정확히 같은지 확인한다.
--   다르면 운영에서 따로 바뀐 내용을 덮어쓸 수 있으므로 아무것도 바꾸지 않고 중단한다(사전 점검 P0 와 같은 기준을 실행 시점에도 강제).
--   기대값: 적용 전 = 2026-10-29 운영 읽기 전용 조회 값, 적용 후 = 이 파일을 격리 DB 에 적용해 측정한 값.
do $$
declare
  r record;
begin
  for r in
    select * from (values
      ('public.center_rows_visible(uuid)', '2be0d75899571b973f43d213713053e3', 'bbbf4e8ea2ce9aac72df0ceddee36243'),
      ('public.fetch_public_storefront_products(uuid)', 'fda8e1821f997e9879c757187ab35a84', 'b40c8da87ee36e7cfd6d3e2cb1880d4c'),
      ('public.fetch_purchasable_products(uuid)', '675be9c77818e1eb61552fc483e51b18', '04286c619a7edb2e2becd98b70394f42')
    ) as t(sig, pre_md5, post_md5)
  loop
    if md5(pg_get_functiondef(to_regprocedure(r.sig))) not in (r.pre_md5, r.post_md5) then
      raise exception 'NICEPAY 심사 분리: % 의 현재 정의가 예상과 달라요(해시 %) — 덮어쓰지 않고 중단합니다. 운영 정의 차이를 먼저 확인하세요.', r.sig, md5(pg_get_functiondef(to_regprocedure(r.sig)));
    end if;
  end loop;
end $$;

-- 클라이언트(앱) 요청인지 판별: JWT 에 사용자(sub)가 있거나, 요청 롤이 anon/authenticated 이면 클라이언트다. 서버(service_role)·SQL Editor(postgres)·cron 은 아니다.
--   auth.uid() is null 만으로 "서버"로 보면, sub 없는 anon/authenticated 요청이 보호 트리거를 통과할 수 있다(RLS 가 먼저 막지만 방어를 겹친다).
create or replace function nicepay_is_client_request()
returns boolean language sql stable set search_path = public as $$
    select auth.uid() is not null or coalesce(nullif(current_setting('role', true), ''), 'none') in ('anon', 'authenticated');
$$;

-- NICEPAY 심사관 전용 권한(토스 심사용 pg_checkout_override 와 별개). 운영자만 지정 가능(본인이 스스로 켤 수 없음) — SQL Editor(auth.uid() is null)·서버(service_role)·플랫폼 관리자만.
-- ⚠ INSERT 도 막는다: "본인 계정 생성" RLS 정책은 auth_id = auth.uid() 만 보고 컬럼 값을 보지 않으므로, UPDATE 만 막으면 가입 시점에 `nicepay_review_access = true` 로 계정을 만들어 우회할 수 있다.
--   정상 가입(앱 가입 화면은 이 컬럼을 보내지 않아 기본값 false)은 그대로 통과한다. upsert(INSERT … ON CONFLICT DO UPDATE)는 INSERT·UPDATE 트리거를 모두 거치므로 같은 기준이다.
alter table accounts add column if not exists nicepay_review_access boolean not null default false;
comment on column accounts.nicepay_review_access is 'NICEPAY 카드사 심사관 전용 권한. true 이면 심사 센터만 보이고 NICEPAY 결제 게이트를 통과한다. pg_checkout_override(토스 심사용)와 독립.';
create or replace function enforce_nicepay_review_access_admin_only()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (tg_op = 'INSERT' and new.nicepay_review_access)
     or (tg_op = 'UPDATE' and new.nicepay_review_access is distinct from old.nicepay_review_access) then
    if nicepay_is_client_request() and not is_platform_admin() then raise exception '이 값은 운영자만 변경할 수 있어요'; end if;
  end if;
  return new;
end $$;
drop trigger if exists trg_accounts_nicepay_review_access_admin_only on accounts;
create trigger trg_accounts_nicepay_review_access_admin_only before insert or update on accounts
  for each row execute function enforce_nicepay_review_access_admin_only();

alter table centers add column if not exists is_nicepay_review boolean not null default false;
comment on column centers.is_nicepay_review is 'NICEPAY 카드사 심사 전용 센터. true 이면 NICEPAY 심사관 계정(accounts.nicepay_review_access)과 해당 센터 매니저/플랫폼 관리자에게만 보인다.';

-- 이 값은 운영자(플랫폼 관리자)/SQL Editor(auth.uid() is null)만 바꿀 수 있다 — 센터 매니저가 자기 센터를 심사 센터로 바꾸거나 심사 센터를 만들 수 없다.
create or replace function enforce_center_nicepay_review_admin_only()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (tg_op = 'INSERT' and new.is_nicepay_review) or (tg_op = 'UPDATE' and new.is_nicepay_review is distinct from old.is_nicepay_review) then
    if nicepay_is_client_request() and not is_platform_admin() then
      raise exception '이 값은 운영자만 변경할 수 있어요';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists trg_centers_nicepay_review_admin_only on centers;
create trigger trg_centers_nicepay_review_admin_only before insert or update on centers
  for each row execute function enforce_center_nicepay_review_admin_only();

-- 심사관 판정: 인증된 사용자(auth.uid())의 계정에 대해서만. 이메일 문자열은 쓰지 않는다. 비로그인은 false.
create or replace function nicepay_is_reviewer()
returns boolean language sql stable security definer set search_path = public as $$
    select coalesce((select a.nicepay_review_access from accounts a where a.id = my_account_id() and a.deactivated_at is null), false);
$$;
revoke all on function nicepay_is_reviewer() from public;
grant execute on function nicepay_is_reviewer() to anon, authenticated, service_role;

-- 센터 접근 판정(단일 기준). service_role 은 RLS 를 타지 않는다.
create or replace function nicepay_review_center_allowed(p_center_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
    select case
        when p_center_id is null then true
        when is_platform_admin() or p_center_id in (select my_managed_center_ids()) then true
        when exists (select 1 from centers c where c.id = p_center_id and c.is_nicepay_review) then nicepay_is_reviewer()
        else not nicepay_is_reviewer()
    end;
$$;
revoke all on function nicepay_review_center_allowed(uuid) from public;
grant execute on function nicepay_review_center_allowed(uuid) to anon, authenticated, service_role;

-- 회원용(탐색 목록 RPC·구매·예약·주문) 접근 판정. 읽기 가시성(nicepay_review_center_allowed)과 달리 NICEPAY 심사관에게는 "매니저 예외"를 주지 않는다 —
-- 심사관이 기존 토스 심사 센터의 매니저여도 그 센터는 관리 화면에서만 쓰고, 상품 목록·구매·예약은 심사 센터에서만 가능하다. 플랫폼 관리자는 예외.
create or replace function nicepay_review_center_member_allowed(p_center_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
    select case
        when p_center_id is null then true
        when is_platform_admin() then true
        when nicepay_is_reviewer() then exists (select 1 from centers c where c.id = p_center_id and c.is_nicepay_review)
        else nicepay_review_center_allowed(p_center_id)
    end;
$$;
revoke all on function nicepay_review_center_member_allowed(uuid) from public;
grant execute on function nicepay_review_center_member_allowed(uuid) to anon, authenticated, service_role;

-- center_rows_visible 에 같은 기준을 AND 로 추가 → 이 함수를 쓰는 정책(휴무일·리뷰·커뮤니티·룸·상담채널·설정·센터항목·센터후기·진도카테고리)과 class_rows_visible/product_rows_visible 이 한 번에 따라온다.
create or replace function public.center_rows_visible(p_center_id uuid)
 returns boolean language sql stable security definer set search_path to 'public' as $$
    select coalesce(
        (
            p_center_id is null
            or not exists (select 1 from public.centers c where c.id = p_center_id and c.is_internal)
            or p_center_id in (select public.my_member_center_ids())
            or p_center_id in (select public.my_managed_center_ids())
            or public.is_platform_admin()
        ) and public.nicepay_review_center_allowed(p_center_id),
        false);
$$;

-- 기존 허용 정책에 AND 로 겹치는 제한 정책(대체 아님 — 기존 정책은 그대로 둔다)
drop policy if exists "nicepay_review_isolation" on centers;
create policy "nicepay_review_isolation" on centers as restrictive for select using (nicepay_review_center_allowed(id));
drop policy if exists "nicepay_review_isolation" on classes;
-- 수업은 예외 1가지: 내 프로필의 예약이 이미 걸린 수업은 센터가 숨겨져도 읽을 수 있다(심사관이 되기 전에 만든 기존 예약을 내 예약 화면에서 보고 취소할 수 있게 — 사후 처리 보존).
-- 센터·상품 목록/구매에는 영향 없음(센터·상품 정책은 예외 없음, 새 예약은 INSERT 트리거가 막는다).
create or replace function nicepay_class_has_my_reservation(p_class_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
    select exists (select 1 from reservations r where r.class_id = p_class_id and r.profile_id in (select my_profile_ids()));
$$;
revoke all on function nicepay_class_has_my_reservation(uuid) from public;
grant execute on function nicepay_class_has_my_reservation(uuid) to anon, authenticated, service_role;
create policy "nicepay_review_isolation" on classes as restrictive for select using (nicepay_review_center_allowed(center_id) or nicepay_class_has_my_reservation(id));
-- 기존 허용 정책("승인된 센터 수업 조회")은 centers 를 서브쿼리로 읽는데 그 centers 가 심사관에게 숨겨지므로, 내 예약이 걸린 수업만 읽는 허용 정책을 추가한다(내 예약만 — 다른 수업은 그대로 숨김).
drop policy if exists "nicepay_own_reservation_class" on classes;
create policy "nicepay_own_reservation_class" on classes for select using (nicepay_class_has_my_reservation(id));
drop policy if exists "nicepay_review_isolation" on products;
create policy "nicepay_review_isolation" on products as restrictive for select using (nicepay_review_center_allowed(center_id));

-- 구매·예약·수강권 발급 경로(RPC 는 SECURITY DEFINER 라 RLS 를 우회하고, orders INSERT 정책은 클라이언트가 보낸 center_id 와 product_id 의 일치를 보지 않는다).
-- 그래서 행이 가리키는 "모든" 센터(행의 center_id + 상품의 실제 센터 + 수업의 센터 + 수강권의 센터)가 (1) 서로 일치하고 (2) 호출자에게 허용된 센터인지 테이블 트리거로 확인한다.
--  · 일치 검사의 근거: orders/memberships/cart_items/purchase_requests 에는 center_id ↔ product_id 소속을 묶는 FK·CHECK·트리거가 없다(FK 는 각각 따로). 발급 함수(_issue_membership_and_record_payment)는
--    주문의 center_id 를 그대로 수강권·결제에 복사하므로, 불일치 주문은 다른 센터 상품 조건으로 한 센터 소속 수강권·매출을 만든다. 운영 데이터는 불일치 0건(주문 22·수강권 24·장바구니 0·구매신청 0).
--  · reservations: 클라이언트는 INSERT 권한이 없고 reserve_class/reserve_with_membership 은 수강권 센터 = 수업 센터를 요구하지만, 매니저 RPC(admin_assign_reservation·manager_book_member)는 수강권을 id 로만 찾아
--    수업 센터와 비교하지 않는다 → 같은 일치 검사를 둔다(운영 예약 19건 불일치 0).
--  · NULL 은 일치 검사에서 제외한다(주문의 product_id null·수강권의 수동 발급 product_id null·예약의 membership_id null 같은 기존 정상 흐름 보존).
-- 클라이언트가 보낸 center_id 만 믿지 않는다. 서버(service_role)·SQL Editor·cron(nicepay_is_client_request() 가 false)은 통과. UPDATE 는 해당 컬럼이 실제로 바뀔 때만 검사한다.
create or replace function nicepay_review_guard_center()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_a uuid; v_b uuid; v_row jsonb := to_jsonb(new);
begin
  if not nicepay_is_client_request() then return new; end if;
  if tg_table_name = 'reservations' then
    select c.center_id into v_a from classes c where c.id = (v_row->>'class_id')::uuid;           -- 수업의 센터
    select m.center_id into v_b from memberships m where m.id = (v_row->>'membership_id')::uuid;  -- 수강권의 센터
    if v_a is not null and v_b is not null and v_a <> v_b then raise exception '수업과 수강권의 센터가 일치하지 않아요'; end if;
  else
    v_a := nullif(v_row->>'center_id', '')::uuid;                                                  -- 행이 주장하는 센터
    select p.center_id into v_b from products p where p.id = (v_row->>'product_id')::uuid;        -- 상품의 실제 센터
    if v_a is not null and v_b is not null and v_a <> v_b then raise exception '센터와 상품이 일치하지 않아요'; end if;
  end if;
  if v_a is not null and not nicepay_review_center_member_allowed(v_a) then raise exception '이 센터의 상품·수업은 이용할 수 없어요'; end if;
  if v_b is not null and not nicepay_review_center_member_allowed(v_b) then raise exception '이 센터의 상품·수업은 이용할 수 없어요'; end if;
  return new;
end $$;
do $$
declare t text; ins text := 'trg_%s_nicepay_review_guard'; upd text := 'trg_%s_nicepay_review_guard_upd';
begin
  foreach t in array array['orders','memberships','cart_items','purchase_requests'] loop
    execute format('drop trigger if exists %I on %I', format(ins, t), t);
    execute format('create trigger %I before insert on %I for each row execute function nicepay_review_guard_center()', format(ins, t), t);
    execute format('drop trigger if exists %I on %I', format(upd, t), t);
    execute format('create trigger %I before update of center_id, product_id on %I for each row when (old.center_id is distinct from new.center_id or old.product_id is distinct from new.product_id) execute function nicepay_review_guard_center()', format(upd, t), t);
  end loop;
  execute 'drop trigger if exists trg_reservations_nicepay_review_guard on reservations';
  execute 'create trigger trg_reservations_nicepay_review_guard before insert on reservations for each row execute function nicepay_review_guard_center()';
  execute 'drop trigger if exists trg_reservations_nicepay_review_guard_upd on reservations';
  execute 'create trigger trg_reservations_nicepay_review_guard_upd before update of class_id, membership_id on reservations for each row when (old.class_id is distinct from new.class_id or old.membership_id is distinct from new.membership_id) execute function nicepay_review_guard_center()';
end $$;

-- 목록 RPC 3개(SECURITY DEFINER — RLS 우회). 현재 정의 + nicepay_review_center_allowed 조건만 추가.
CREATE OR REPLACE FUNCTION public.fetch_public_storefront_products(p_center_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(id uuid, center_id uuid, center_name text, name text, price integer, product_kind text, description text, total_count integer, unlimited boolean, unlimited_pass boolean, group_label text, remaining integer, purchase_count_selectable boolean, min_purchase_count integer, max_purchase_count integer, min_tier_price integer, max_tier_price integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
    select
        p.id,
        p.center_id,
        c.name,
        p.name,
        p.price,
        p.product_kind,
        p.description,
        p.total_count,
        p.unlimited,
        p.unlimited_pass,
        p.group_label,
        case
            when p.max_quantity is null then null
            else greatest(
                0,
                p.max_quantity - (
                    select count(*)::int from memberships m
                    where m.product_id = p.id and m.status <> 'refunded'
                )
            )
        end,
        coalesce(p.purchase_count_selectable, false),
        (select min(t.count) from product_count_prices t where t.product_id = p.id),
        (select max(t.count) from product_count_prices t where t.product_id = p.id),
        (select min(t.price) from product_count_prices t where t.product_id = p.id),
        (select max(t.price) from product_count_prices t where t.product_id = p.id)
    from products p
    join centers c on c.id = p.center_id
    where c.status = 'approved'
      and not c.is_internal   -- QA/내부 센터는 공개 목록에 절대 나오지 않는다
      and nicepay_review_center_member_allowed(c.id)   -- [NICEPAY 심사 분리] 심사 센터는 심사관에게만, 심사관에게는 심사 센터만
      and p.is_active
      and p.is_on_sale
      and p.visibility_type = 'all'
      -- 횟수 선택형인데 가격표가 아직 없으면(설정 중) 공개하지 않는다
      and (not coalesce(p.purchase_count_selectable, false)
           or exists (select 1 from product_count_prices t where t.product_id = p.id))
      and (p_center_id is null or p.center_id = p_center_id)
    order by c.name asc, p.product_kind asc, p.price asc
    limit 500;
$function$;
revoke all on function fetch_public_storefront_products(uuid) from public;
grant execute on function fetch_public_storefront_products(uuid) to anon, authenticated;

CREATE OR REPLACE FUNCTION public.fetch_purchasable_products(p_center_id uuid)
 RETURNS SETOF products
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
    select p.* from products p
    where p.center_id = p_center_id
      and nicepay_review_center_member_allowed(p.center_id)   -- [NICEPAY 심사 분리]
      -- QA/내부 센터(centers.is_internal)는 그 센터의 회원/관리자만 상품을 조회할 수 있다(UUID를 알아도 일반 계정은 빈 목록)
      and (
        not exists (select 1 from centers c where c.id = p.center_id and c.is_internal)
        or p.center_id in (select my_member_center_ids())
        or p.center_id in (select my_managed_center_ids())
      )
      and p.is_active
      and p.is_on_sale
      and (
        p.visibility_type = 'all'
        or (
            p.visibility_type = 'grades' and exists (
                select 1 from membership_product_grades mpg
                join center_members cm
                  on cm.center_id = p.center_id
                 and cm.profile_id in (select my_profile_ids())
                 and cm.grade_id = mpg.grade_id
                where mpg.product_id = p.id
            )
        )
        or (
            p.visibility_type = 'selected_members' and exists (
                select 1 from membership_product_members mpm
                join center_members cm
                  on cm.center_id = p.center_id
                 and cm.profile_id in (select my_profile_ids())
                 and cm.id = mpm.center_member_id
                where mpm.product_id = p.id
            )
        )
      )
    order by p.product_kind asc, p.price asc;
$function$;
revoke all on function public.fetch_purchasable_products(uuid) from public, anon;
grant execute on function public.fetch_purchasable_products(uuid) to authenticated, service_role;

create or replace function fetch_public_storefront_product_periods(p_center_id uuid default null)
returns table (
    product_id uuid,
    expiry_mode text,
    expiry_days integer,
    expiry_date date,
    rolling_month_cutoff_day integer,
    rolling_month_allow_early_use boolean
)
language sql
stable
security definer
set search_path = public
as $$
    select
        p.id,
        p.expiry_mode,
        p.expiry_days,
        p.expiry_date,
        p.rolling_month_cutoff_day,
        coalesce(p.rolling_month_allow_early_use, false)
    from products p
    join centers c on c.id = p.center_id
    where c.status = 'approved'
      and not c.is_internal
      and p.is_active
      and p.is_on_sale
      and p.visibility_type = 'all'
      and (not coalesce(p.purchase_count_selectable, false)
           or exists (select 1 from product_count_prices t where t.product_id = p.id))
      and nicepay_review_center_member_allowed(c.id)   -- [NICEPAY 심사 분리]
      and (p_center_id is null or p.center_id = p_center_id)
    limit 500;
$$;
revoke all on function fetch_public_storefront_product_periods(uuid) from public;
grant execute on function fetch_public_storefront_product_periods(uuid) to anon, authenticated;
do $$ begin
  if not (select existed from _nicepay_periods_existed) then
    comment on function fetch_public_storefront_product_periods(uuid) is 'created_by:add_nicepay_review_center_isolation_20261028 (rollback 시 삭제)';
  end if;
end $$;

COMMIT;
```

### 2. `fix_nicepay_gate_reviewer_flag_20261029.sql` — P2b
- 설명: 운영에 적용된 NICEPAY 게이트 함수 2개의 심사관 판별을 전용 권한으로 치환
- 줄 수: 72 · SHA-256: `46bb12c7fe752d48cacdfe56d8be90e41440928eb04e19fd9400a479884fb96f`

```sql
-- ============================================================
-- NICEPAY 결제 게이트의 "심사관" 판별을 전용 권한(accounts.nicepay_review_access) + 심사 센터 소속 검증으로 강화(2026-10-29, 외부 SQL 리뷰 반영 개정) — 검토용 초안, 운영 미실행.
--
-- 배경: 운영에 이미 적용된 두 함수가 mode='reviewer' 일 때 심사관을 accounts.pg_checkout_override(토스용)로만 판별한다.
--   · orders_guard_nicepay_create()  — 20261017134256_add_nicepay_checkout_gate_20261017 (NICEPAY 대기 주문 생성 트리거)
--   · nicepay_claim_order(uuid)      — 20261017151331_add_nicepay_provider_support_20261016_v8 (승인 선점)
-- 변경(두 함수 모두, 문자열 치환 2곳씩 — 다른 로직은 바꾸지 않는다):
--   ① 판별 권한: pg_checkout_override → nicepay_review_access (토스 심사 계정이 NICEPAY 주문을 만들 수 없게)
--   ② 대상 검증: reviewer 모드에서는 "주문의 실제 센터와 상품이 심사 대상인지"도 확인한다(nicepay_order_is_review_target: 승인·비내부 심사 센터 + 그 센터의 판매 중 상품, 상품 NULL 은 제외).
--      권한만 보면 심사관 계정이 운영 센터 주문으로도 NICEPAY 결제 게이트를 통과할 수 있다(센터 분리 SQL 의 트리거가 없거나 서버(service_role) 경로로 만든 주문이면 막는 곳이 없다).
--   public/off 모드, 과거 결제 처리(이미 approving 인 주문의 승인 기록·확정·취소·release·환불), service_role 의 주문 생성 경로는 바뀌지 않는다.
-- 안전장치(덮어쓰기 방지): 대상 두 함수의 "현재 정의 해시"가 ⓐ 적용 전 운영 정의(2026-10-29 읽기 전용 조회 값) 또는 ⓑ 이 파일을 적용한 결과 정의와 정확히 같을 때만 진행한다.
--   ⓐ 도 ⓑ 도 아니면(운영에서 따로 바뀐 정의) 아무것도 바꾸지 않고 중단한다. 치환 후 정의 해시가 기대값과 다르면 트랜잭션 전체를 롤백한다.
-- 전제: add_nicepay_review_center_isolation_20261028.sql(P2)이 먼저 적용돼 accounts.nicepay_review_access·centers.is_nicepay_review 가 있어야 한다(없으면 중단).
-- 영향: mode 가 'off'(현재)이면 동작 차이 없음. 'reviewer' 모드에서 NICEPAY 주문 생성·승인 선점이 "전용 권한 계정 + 심사 센터 주문"에만 허용된다. 'public' 모드는 영향 없음.
-- 롤백: rollback_fix_nicepay_gate_reviewer_flag_20261029.sql(게이트 mode 가 off 일 때만 실행). 검증: verify_fix_nicepay_gate_reviewer_flag_20261029.sql(읽기 전용).
-- ============================================================
begin;
do $$
declare
    r record; v_def text; v_new text; v_h text; v_n int;
begin
    if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='accounts' and column_name='nicepay_review_access') then
        raise exception 'accounts.nicepay_review_access 가 없어요 — add_nicepay_review_center_isolation_20261028.sql 을 먼저 적용하세요';
    end if;
    if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='centers' and column_name='is_nicepay_review') then
        raise exception 'centers.is_nicepay_review 가 없어요 — add_nicepay_review_center_isolation_20261028.sql 을 먼저 적용하세요';
    end if;
    if to_regprocedure('public.nicepay_checkout_mode()') is null then
        raise exception 'nicepay_checkout_mode() 가 없어요 — NICEPAY 게이트 SQL 이 적용돼 있어야 해요';
    end if;
    -- 대상 판정 helper — reviewer 모드 전용. 모두 만족해야 "심사 대상 주문"이다:
    --   · 센터가 심사 센터이고 승인(approved)·비내부 상태(심사관에게 실제로 열려 있는 센터. 닫힌/비승인 센터의 대기 주문은 선점 불가)
    --   · 상품이 있고(NULL 상품 주문은 서버가 계산한 금액이 없어 심사 결제 대상이 아니다 — 앱은 항상 product_id 를 보낸다), 그 센터의 상품이며, 판매 중(is_active·is_on_sale: create_order_secure 와 member_can_purchase_product 의 구매 조건과 동일)
    -- 이 함수는 두 게이트 함수(소유자 권한)만 호출한다. public/off 모드와 이미 approving 인 주문의 후속 처리는 이 함수를 쓰지 않는다.
    create or replace function public.nicepay_order_is_review_target(p_center_id uuid, p_product_id uuid)
    returns boolean language sql stable security definer set search_path = public as $f$
        select p_center_id is not null and p_product_id is not null
           and exists (select 1 from centers c where c.id = p_center_id and c.is_nicepay_review and c.status = 'approved' and not c.is_internal)
           and exists (select 1 from products pr where pr.id = p_product_id and pr.center_id = p_center_id and pr.is_active and pr.is_on_sale);
    $f$;
    revoke all on function public.nicepay_order_is_review_target(uuid, uuid) from public, anon, authenticated;

    for r in
        select * from (values
            ('public.orders_guard_nicepay_create()', 'b2f340d8d41fc2428e26c7cde3aaafd4', '721bef6e27646547535cfe7b05393f88'),
            ('public.nicepay_claim_order(uuid)',     '4cb7d4ece28db732bd5886088c034609', 'd7145831da2f416612818d2e4fe5d5fc')
        ) as t(sig, pre_md5, post_md5)
    loop
        if to_regprocedure(r.sig) is null then raise exception '% 가 없어요 — NICEPAY 게이트/지원 SQL 이 적용돼 있어야 해요', r.sig; end if;
        v_def := pg_get_functiondef(to_regprocedure(r.sig)); v_h := md5(v_def);
        if v_h = r.post_md5 then raise notice '%: 이미 이 파일의 정의로 바뀜 — 건너뜀', r.sig; continue; end if;
        if v_h <> r.pre_md5 then
            raise exception '% 의 현재 정의가 예상(적용 전 운영 정의/이 파일 적용본)과 달라요(해시 %) — 덮어쓰지 않고 중단합니다', r.sig, v_h;
        end if;
        if r.sig like 'public.orders_guard%' then
            v_n := (length(v_def) - length(replace(v_def, 'a.pg_checkout_override', ''))) / length('a.pg_checkout_override');
            if v_n <> 1 then raise exception '%: 치환 위치가 예상(1곳)과 달라요(%곳) — 중단', r.sig, v_n; end if;
            v_new := replace(v_def, 'a.pg_checkout_override', 'a.nicepay_review_access and nicepay_order_is_review_target(new.center_id, new.product_id)');
        else
            v_n := (length(v_def) - length(replace(v_def, 'ga.pg_checkout_override', ''))) / length('ga.pg_checkout_override');
            if v_n <> 1 then raise exception '%: 치환 위치가 예상(1곳)과 달라요(%곳) — 중단', r.sig, v_n; end if;
            v_new := replace(v_def, 'ga.pg_checkout_override', 'ga.nicepay_review_access and nicepay_order_is_review_target(go.center_id, go.product_id)');
            v_new := replace(v_new, 'accounts.pg_checkout_override', 'accounts.nicepay_review_access + 심사 센터 주문');   -- 설명 주석만
        end if;
        execute v_new;
        if md5(pg_get_functiondef(to_regprocedure(r.sig))) <> r.post_md5 then
            raise exception '% 치환 결과 정의 해시가 기대값과 달라요 — 트랜잭션 전체를 롤백합니다', r.sig;
        end if;
    end loop;
end $$;
commit;
```

### 3. `verify_add_nicepay_review_center_isolation_20261028.sql` — V-P2
- 설명: P2 적용 후 읽기 전용 검증
- 줄 수: 34 · SHA-256: `e442f3ff53be4cff7b7ed6b264525ef2b8fa75acd38df204c581937a28f1f2d9`

```sql
-- 읽기 전용 확인(SQL Editor/postgres 로 실행 — 변경 없음). 역할별 가시성은 아래 "역할 시뮬레이션"으로 확인한다.
-- 1) 객체
select
  (select count(*) from information_schema.columns where table_schema='public'
     and ((table_name='centers' and column_name='is_nicepay_review') or (table_name='accounts' and column_name='nicepay_review_access'))) as columns_must_be_2,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname='public'
     and p.proname in ('nicepay_is_reviewer','nicepay_review_center_allowed','nicepay_review_center_member_allowed','nicepay_class_has_my_reservation','nicepay_review_guard_center','enforce_center_nicepay_review_admin_only','enforce_nicepay_review_access_admin_only','nicepay_is_client_request')) as new_functions_must_be_8,
  (select count(*) from pg_policies where policyname='nicepay_review_isolation') as restrictive_policies_must_be_3,
  (select count(*) from pg_policies where policyname='nicepay_own_reservation_class') as own_reservation_policy_must_be_1,
  (select count(*) from pg_trigger where not tgisinternal and tgname ~ '^trg_(centers|accounts|orders|memberships|cart_items|purchase_requests|reservations)_nicepay_review_') as triggers_must_be_12,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname='public'
     and p.proname in ('fetch_public_storefront_products','fetch_purchasable_products','fetch_public_storefront_product_periods')
     and position('nicepay_review_center_member_allowed' in pg_get_functiondef(p.oid)) > 0) as list_rpcs_replaced_must_be_3,
  position('nicepay_review_center_allowed' in pg_get_functiondef('public.center_rows_visible(uuid)'::regprocedure)) > 0 as center_rows_visible_replaced_must_be_true,
  (md5(pg_get_functiondef('public.center_rows_visible(uuid)'::regprocedure)) = 'bbbf4e8ea2ce9aac72df0ceddee36243' and md5(pg_get_functiondef('public.fetch_public_storefront_products(uuid)'::regprocedure)) = 'b40c8da87ee36e7cfd6d3e2cb1880d4c' and md5(pg_get_functiondef('public.fetch_purchasable_products(uuid)'::regprocedure)) = '04286c619a7edb2e2becd98b70394f42') as replaced_definitions_match_expected_must_be_true,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname='public'
     and p.proname in ('nicepay_is_reviewer','nicepay_review_center_allowed','nicepay_review_center_member_allowed','nicepay_class_has_my_reservation')
     and has_function_privilege('public', p.oid, 'execute')) as helpers_executable_by_public_must_be_0;
-- 2) 기존 센터 보존: 아래 두 값은 적용 전후 같아야 한다(적용 전에 먼저 기록).
select (select count(*) from centers where not is_nicepay_review) as existing_centers,
       (select count(*) from products p join centers c on c.id=p.center_id where not c.is_nicepay_review) as existing_products;
-- 3) 심사 센터/심사관 현황(심사관 수는 의도한 1명인지 확인)
select (select count(*) from centers where is_nicepay_review) as review_centers,
       (select count(*) from accounts where nicepay_review_access and deactivated_at is null) as nicepay_reviewer_accounts,
       (select count(*) from accounts where pg_checkout_override and deactivated_at is null) as toss_override_accounts_unchanged;
-- 4) 역할 시뮬레이션(트랜잭션 안에서만, 마지막에 ROLLBACK). <일반회원_auth_id>/<심사관_auth_id> 를 실제 값으로 바꿔 실행.
-- begin;
--   set local role authenticated; select set_config('request.jwt.claims', json_build_object('sub','<일반회원_auth_id>','role','authenticated')::text, true);
--   select count(*) as normal_sees_review_center_must_be_0 from centers where is_nicepay_review;
--   select count(*) as normal_sees_operating_centers from centers where not is_nicepay_review;
--   select set_config('request.jwt.claims', json_build_object('sub','<심사관_auth_id>','role','authenticated')::text, true);
--   select count(*) as reviewer_sees_review_center_must_be_1 from centers where is_nicepay_review;
--   select count(*) as reviewer_sees_operating_centers_must_be_0 from centers where not is_nicepay_review;
-- rollback;
```

### 4. `verify_fix_nicepay_gate_reviewer_flag_20261029.sql` — V-P2b
- 설명: P2b 적용 후 읽기 전용 검증
- 줄 수: 15 · SHA-256: `4c5f5f3dc1aa35be96f157d9823a3bd84b13b879debc0d8fe17a9cbe7ded3734`

```sql
-- 읽기 전용 확인(P2b 적용 후): 모두 true 여야 한다.
--  · 두 게이트 함수가 새 권한과 심사 센터 소속 검증(nicepay_order_is_review_target)을 쓰고, 옛 토스 플래그는 코드에서 쓰지 않는다
--  · 정의 해시가 이 파일 적용본과 같다(721bef6e27646547535cfe7b05393f88/d7145831da2f416612818d2e4fe5d5fc) · helper 존재·PUBLIC 실행 불가
select p.proname,
       position('nicepay_review_access' in pg_get_functiondef(p.oid)) > 0 as uses_new_flag,
       position('nicepay_order_is_review_target' in pg_get_functiondef(p.oid)) > 0 as checks_review_target,
       position('pg_checkout_override' in pg_get_functiondef(p.oid)) > 0 as still_uses_old_flag_must_be_false,
       md5(pg_get_functiondef(p.oid)) = case p.proname when 'orders_guard_nicepay_create' then '721bef6e27646547535cfe7b05393f88' else 'd7145831da2f416612818d2e4fe5d5fc' end as definition_matches_expected
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname in ('orders_guard_nicepay_create', 'nicepay_claim_order') order by 1;
select to_regprocedure('public.nicepay_order_is_review_target(uuid,uuid)') is not null as helper_exists,
       (select position('is_on_sale' in pg_get_functiondef(to_regprocedure('public.nicepay_order_is_review_target(uuid,uuid)'))) > 0 and position('is_internal' in pg_get_functiondef(to_regprocedure('public.nicepay_order_is_review_target(uuid,uuid)'))) > 0 and position('p_product_id is not null' in pg_get_functiondef(to_regprocedure('public.nicepay_order_is_review_target(uuid,uuid)'))) > 0) as helper_requires_approved_center_and_on_sale_product,
       not has_function_privilege('public', to_regprocedure('public.nicepay_order_is_review_target(uuid,uuid)')::oid, 'execute') as helper_not_executable_by_public,
       not has_function_privilege('authenticated', to_regprocedure('public.nicepay_order_is_review_target(uuid,uuid)')::oid, 'execute') as helper_not_executable_by_authenticated,
       (select mode from nicepay_checkout_gate where id) as gate_mode_info;
```

### 5. `rollback_add_nicepay_review_center_isolation_20261028.sql` — RB-P2
- 설명: P2 롤백(공개 가능한 심사 센터가 있으면 중단)
- 줄 수: 250 · SHA-256: `b56d97c4949a364df1b5814468f49dacb211895a04a362fcce0adb437bd41dfd`

```sql
-- add_nicepay_review_center_isolation_20261028.sql 되돌리기: 정책·트리거·신규 함수 삭제, 함수 4개를 이전 정의로 복원. centers.is_nicepay_review 컬럼과 심사 센터 데이터는 남긴다(데이터 보존).
-- ⚠ 안전장치: 롤백하면 분리 규칙이 사라져 심사 센터·상품·수업이 일반 회원에게 보일 수 있다. 일반 공개 가능 상태(승인된 비내부 심사 센터)가 하나라도 있으면 이 스크립트는 아무것도 바꾸지 않고 중단한다.
--   먼저 심사 센터를 비공개로 돌린다. 센터 하나만 닫으면 그 센터의 상품·수업 직접 조회까지 같이 막힌다(기존 "상품 조회"/"승인된 센터 수업 조회" 정책이 승인된 비내부 센터만 허용).
--   방법 ① SQL Editor: update centers set is_internal = true where is_nicepay_review;   -- 심사 센터 행만. 기존 운영 센터 변경 없음(is_internal 은 별도 보호 트리거가 없다)
--   방법 ② 플랫폼 관리자 계정으로 센터 승인 상태를 되돌림(status 는 guard_center_status_change 트리거가 플랫폼 관리자만 변경 허용 — SQL Editor 의 postgres 로는 변경 불가).
--   그 뒤 이 스크립트를 실행한다. (심사 센터 데이터는 삭제하지 않는다.)
-- ⚠ 추가 안전장치(2026-10-30): 정책 제거 전후로 실제 인증 컨텍스트(계정별 JWT)의 심사 센터·상품·수업 가시성을 측정해, 일반 회원 관계(center_members 등) 때문에 노출이 늘어나는 계정이 하나라도 있으면 전체 롤백한다. 관계 데이터는 자동 삭제·수정하지 않는다.
-- 남기는 것: accounts.nicepay_review_access 컬럼·보호 트리거(INSERT·UPDATE 모두 보호, 값이 있을 수 있어 데이터 보존. 완전 제거는 별도 승인)와 그 트리거가 의존하는 함수 2개(enforce_nicepay_review_access_admin_only, nicepay_is_client_request), centers.is_nicepay_review 컬럼.
-- 복원 규칙(기간 RPC): 분리 SQL 이 그 함수를 새로 만들었다면(함수 주석 표식) 삭제, 분리 SQL 적용 전부터 있었다면 add_public_storefront_product_periods_20261027.sql 정의로 복원.
BEGIN;
do $$
begin
  -- 역순 롤백 강제: P2b(게이트 함수 패치)가 적용돼 있으면 먼저 rollback_fix_nicepay_gate_reviewer_flag_20261029.sql 을 실행해야 한다(P2b 는 P2 의 컬럼에 의존).
  if to_regprocedure('public.nicepay_order_is_review_target(uuid,uuid)') is not null then
    raise exception '롤백 중단: P2b(NICEPAY 게이트 판별 패치)가 아직 적용돼 있어요. 먼저 rollback_fix_nicepay_gate_reviewer_flag_20261029.sql 을 실행하세요.';
  end if;
  if exists (select 1 from information_schema.columns where table_schema='public' and table_name='centers' and column_name='is_nicepay_review')
     and exists (select 1 from centers where is_nicepay_review and status = 'approved' and not is_internal) then
    raise exception '롤백 중단: 일반 사용자에게 공개될 수 있는 심사 센터가 있어요. 먼저 update centers set is_internal = true where is_nicepay_review; 를 실행하세요(또는 플랫폼 관리자가 센터 승인 상태를 되돌리세요).';
  end if;
end $$;
-- ─ 노출 증가 검사 ①(정책을 지우기 "전" 기준값): 기존 센터 조회 정책은 "내부 센터라도 그 센터에 등록된 회원(center_members)·활성/비활성 매니저"에게 센터·상품·수업 조회를 허용한다.
--   그래서 심사 센터를 is_internal=true 로 닫아도, 심사 센터에 등록된 일반 회원이 남아 있으면 P2 분리 정책을 지우는 순간 그 회원에게 심사 센터가 보이게 된다.
--   실제 인증 컨텍스트(set local role + JWT sub)로 각 계정이 보는 심사 센터·상품·수업·구매 RPC 건수를 지금(정책 적용 중) 기록하고, 맨 끝(정책 제거 후)에 다시 측정해 "늘어난 계정"이 있으면 전체를 롤백한다.
--   대상 계정: 심사 센터에 회원 등록(center_members)·수강권·주문·장바구니·구매신청·예약이 있는 계정 + 심사 센터 매니저 + 최근 계정 30개(그 밖의 우회 경로 감시) + 비로그인(anon). 아무것도 삭제·수정하지 않는다.
do $$
declare v_ids uuid[]; r record;
begin
  select coalesce(array_agg(id), '{}') into v_ids from centers where is_nicepay_review;
  create temp table _nicepay_rb_probe(who text, auth_id uuid, sig text) on commit drop;   -- 이 트랜잭션 안에서만 존재(COMMIT/ROLLBACK 시 자동 삭제)
  create or replace function pg_temp.nicepay_rb_probe(p_auth uuid, p_ids uuid[]) returns text language plpgsql as $f$
  declare c int; p int; cl int; rp int; rs int;
  begin
    perform set_config('request.jwt.claims', case when p_auth is null then '' else json_build_object('sub', p_auth, 'role', 'authenticated')::text end, true);
    execute case when p_auth is null then 'set local role anon' else 'set local role authenticated' end;
    select count(*) into c from public.centers where id = any(p_ids);
    select count(*) into p from public.products where center_id = any(p_ids);
    select count(*) into cl from public.classes where center_id = any(p_ids);
    begin select count(*) into rp from unnest(p_ids) u(cid), lateral public.fetch_purchasable_products(u.cid) f;
    exception when insufficient_privilege then rp := 0; end;   -- 실행 권한이 없는 역할(anon 등)은 노출 0
    begin select count(*) into rs from unnest(p_ids) u(cid), lateral public.fetch_public_storefront_products(u.cid) f;
    exception when insufficient_privilege then rs := 0; end;
    execute 'reset role'; perform set_config('request.jwt.claims', '', true);
    return c || '/' || p || '/' || cl || '/' || rp || '/' || rs;
  exception when others then
    begin execute 'reset role'; exception when others then null; end;
    raise exception '롤백 중단: 노출 여부를 확인하지 못했어요(%): % — 안전을 위해 아무것도 바꾸지 않습니다.', coalesce(p_auth::text, 'anon'), sqlerrm;
  end $f$;
  insert into _nicepay_rb_probe values ('anon', null, pg_temp.nicepay_rb_probe(null, v_ids));
  for r in
    select distinct a.auth_id from accounts a where a.auth_id is not null and (
      a.id in (select p.account_id from profiles p where p.id in (
          select profile_id from center_members where center_id = any(v_ids)
          union select profile_id from memberships where center_id = any(v_ids)
          union select profile_id from orders where center_id = any(v_ids)
          union select profile_id from cart_items where center_id = any(v_ids)
          union select profile_id from purchase_requests where center_id = any(v_ids)
          union select rs.profile_id from reservations rs join classes cl on cl.id = rs.class_id where cl.center_id = any(v_ids)))
      or a.id in (select account_id from manager_centers where center_id = any(v_ids))
      or a.id in (select id from accounts order by created_at desc limit 30))
  loop
    insert into _nicepay_rb_probe values (r.auth_id::text, r.auth_id, pg_temp.nicepay_rb_probe(r.auth_id, v_ids));
  end loop;
end $$;
drop policy if exists "nicepay_review_isolation" on centers;
drop policy if exists "nicepay_review_isolation" on classes;
drop policy if exists "nicepay_own_reservation_class" on classes;
drop policy if exists "nicepay_review_isolation" on products;
do $$
declare t text;
begin
  foreach t in array array['orders','memberships','cart_items','purchase_requests','reservations'] loop
    execute format('drop trigger if exists %I on %I', format('trg_%s_nicepay_review_guard', t), t);
    execute format('drop trigger if exists %I on %I', format('trg_%s_nicepay_review_guard_upd', t), t);
  end loop;
end $$;
drop trigger if exists trg_centers_nicepay_review_admin_only on centers;
create or replace function public.center_rows_visible(p_center_id uuid)
 returns boolean language sql stable security definer set search_path to 'public' as $$
    select coalesce(
        p_center_id is null
        or not exists (select 1 from public.centers c where c.id = p_center_id and c.is_internal)
        or p_center_id in (select public.my_member_center_ids())
        or p_center_id in (select public.my_managed_center_ids())
        or public.is_platform_admin(),
        false);
$$;

CREATE OR REPLACE FUNCTION public.fetch_public_storefront_products(p_center_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(id uuid, center_id uuid, center_name text, name text, price integer, product_kind text, description text, total_count integer, unlimited boolean, unlimited_pass boolean, group_label text, remaining integer, purchase_count_selectable boolean, min_purchase_count integer, max_purchase_count integer, min_tier_price integer, max_tier_price integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
    select
        p.id,
        p.center_id,
        c.name,
        p.name,
        p.price,
        p.product_kind,
        p.description,
        p.total_count,
        p.unlimited,
        p.unlimited_pass,
        p.group_label,
        case
            when p.max_quantity is null then null
            else greatest(
                0,
                p.max_quantity - (
                    select count(*)::int from memberships m
                    where m.product_id = p.id and m.status <> 'refunded'
                )
            )
        end,
        coalesce(p.purchase_count_selectable, false),
        (select min(t.count) from product_count_prices t where t.product_id = p.id),
        (select max(t.count) from product_count_prices t where t.product_id = p.id),
        (select min(t.price) from product_count_prices t where t.product_id = p.id),
        (select max(t.price) from product_count_prices t where t.product_id = p.id)
    from products p
    join centers c on c.id = p.center_id
    where c.status = 'approved'
      and not c.is_internal   -- QA/내부 센터는 공개 목록에 절대 나오지 않는다
      and p.is_active
      and p.is_on_sale
      and p.visibility_type = 'all'
      -- 횟수 선택형인데 가격표가 아직 없으면(설정 중) 공개하지 않는다
      and (not coalesce(p.purchase_count_selectable, false)
           or exists (select 1 from product_count_prices t where t.product_id = p.id))
      and (p_center_id is null or p.center_id = p_center_id)
    order by c.name asc, p.product_kind asc, p.price asc
    limit 500;
$function$;
revoke all on function fetch_public_storefront_products(uuid) from public;
grant execute on function fetch_public_storefront_products(uuid) to anon, authenticated;

CREATE OR REPLACE FUNCTION public.fetch_purchasable_products(p_center_id uuid)
 RETURNS SETOF products
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
    select p.* from products p
    where p.center_id = p_center_id
      -- QA/내부 센터(centers.is_internal)는 그 센터의 회원/관리자만 상품을 조회할 수 있다(UUID를 알아도 일반 계정은 빈 목록)
      and (
        not exists (select 1 from centers c where c.id = p.center_id and c.is_internal)
        or p.center_id in (select my_member_center_ids())
        or p.center_id in (select my_managed_center_ids())
      )
      and p.is_active
      and p.is_on_sale
      and (
        p.visibility_type = 'all'
        or (
            p.visibility_type = 'grades' and exists (
                select 1 from membership_product_grades mpg
                join center_members cm
                  on cm.center_id = p.center_id
                 and cm.profile_id in (select my_profile_ids())
                 and cm.grade_id = mpg.grade_id
                where mpg.product_id = p.id
            )
        )
        or (
            p.visibility_type = 'selected_members' and exists (
                select 1 from membership_product_members mpm
                join center_members cm
                  on cm.center_id = p.center_id
                 and cm.profile_id in (select my_profile_ids())
                 and cm.id = mpm.center_member_id
                where mpm.product_id = p.id
            )
        )
      )
    order by p.product_kind asc, p.price asc;
$function$;
revoke all on function public.fetch_purchasable_products(uuid) from public, anon;
grant execute on function public.fetch_purchasable_products(uuid) to authenticated, service_role;

-- 기간 RPC: 분리 SQL 이 만든 것이면 삭제, 이전부터 있었으면 이전 정의로 복원
do $do$ begin
  if to_regprocedure('fetch_public_storefront_product_periods(uuid)') is not null then
    if coalesce(obj_description('fetch_public_storefront_product_periods(uuid)'::regprocedure, 'pg_proc'), '') like 'created_by:add_nicepay_review_center_isolation_20261028%' then
      drop function fetch_public_storefront_product_periods(uuid);
    else
      execute $f$create or replace function fetch_public_storefront_product_periods(p_center_id uuid default null)
returns table (
    product_id uuid,
    expiry_mode text,
    expiry_days integer,
    expiry_date date,
    rolling_month_cutoff_day integer,
    rolling_month_allow_early_use boolean
)
language sql
stable
security definer
set search_path = public
as $$
    select
        p.id,
        p.expiry_mode,
        p.expiry_days,
        p.expiry_date,
        p.rolling_month_cutoff_day,
        coalesce(p.rolling_month_allow_early_use, false)
    from products p
    join centers c on c.id = p.center_id
    where c.status = 'approved'
      and not c.is_internal
      and p.is_active
      and p.is_on_sale
      and p.visibility_type = 'all'
      and (not coalesce(p.purchase_count_selectable, false)
           or exists (select 1 from product_count_prices t where t.product_id = p.id))
      and (p_center_id is null or p.center_id = p_center_id)
    limit 500;
$$;$f$;
    end if;
  end if;
end $do$;
drop function if exists nicepay_class_has_my_reservation(uuid);
-- nicepay_is_client_request() 는 삭제하지 않는다: 남기는 accounts 보호 트리거(enforce_nicepay_review_access_admin_only)가 호출한다. 지우면 롤백 뒤 권한 컬럼을 건드리는 모든 INSERT/UPDATE(관리자·서버·SQL Editor 포함)가 "function does not exist" 로 실패한다.
drop function if exists nicepay_review_guard_center();
drop function if exists enforce_center_nicepay_review_admin_only();
drop function if exists nicepay_review_center_member_allowed(uuid);
drop function if exists nicepay_review_center_allowed(uuid);
drop function if exists nicepay_is_reviewer();
-- ─ 노출 증가 검사 ②(정책·함수 제거 "후"): 앞에서 기록한 계정별 건수와 비교해 하나라도 늘었으면 예외 → 이 파일의 모든 변경이 롤백된다(회원·프로필·주문·수강권·예약은 건드리지 않는다).
do $$
declare v_ids uuid[]; r record; v_new text; b int[]; a int[]; v_msg text := ''; v_n int := 0; v_rel int;
begin
  select coalesce(array_agg(id), '{}') into v_ids from centers where is_nicepay_review;
  for r in select * from _nicepay_rb_probe loop
    v_new := pg_temp.nicepay_rb_probe(r.auth_id, v_ids);
    b := string_to_array(r.sig, '/')::int[]; a := string_to_array(v_new, '/')::int[];
    if exists (select 1 from generate_subscripts(a, 1) i where a[i] > b[i]) then
      v_n := v_n + 1; if v_n <= 5 then v_msg := v_msg || format(' [%s 센터/상품/수업/구매RPC/공개RPC %s → %s]', left(r.who, 8), r.sig, v_new); end if;
    end if;
  end loop;
  if v_n > 0 then
    select count(*) into v_rel from center_members where center_id = any(v_ids);
    raise exception '롤백 중단: 이 롤백을 적용하면 심사 센터·상품·수업이 계정 %개에게 새로 보이게 돼요(심사 센터 회원 등록 %건 등).%  기존 센터 조회 정책이 "내부 센터라도 등록된 회원에게 조회 허용"이라서예요. 회원·프로필·주문·수강권·예약은 삭제·수정하지 않았고 P2 분리 정책도 그대로 유지돼요. 해결: 심사 센터의 회원 관계를 승인된 절차로 정리하거나, P2 분리 정책을 그대로 두세요(권장 — 롤백하지 않아도 일반 사용자에게는 보이지 않습니다).', v_n, v_rel, v_msg;
  end if;
  drop function pg_temp.nicepay_rb_probe(uuid, uuid[]);
end $$;
COMMIT;
```

### 6. `rollback_fix_nicepay_gate_reviewer_flag_20261029.sql` — RB-P2b
- 설명: P2b 롤백(역치환)
- 줄 수: 44 · SHA-256: `b2b55dc804bc8878dc0bbe06ca597be37865588e9b5c533d850f0d8ffe46d7c5`

```sql
-- fix_nicepay_gate_reviewer_flag_20261029.sql 되돌리기: 두 게이트 함수를 적용 전 운영 정의로 복원하고 helper 를 삭제한다.
-- ⚠ 안전장치: 게이트 mode 가 'off' 가 아니면 오류로 중단한다(reviewer/public 모드에서 판별 로직을 되돌리면 진행 중인 심사 결제의 승인 선점 판정이 도중에 바뀐다).
--   먼저 mode 를 off 로 닫고(close_nicepay_review_20261029.sql 또는 update nicepay_checkout_gate set mode='off'), 진행 중(approving) 거래가 없는지 확인한 뒤 실행한다.
-- ⚠ 진행 중 거래 안전장치: payment_provider='nicepay' 이고 status='approving'(승인 선점 후 미해소) 주문이 하나라도 있으면 아무것도 바꾸지 않고 중단한다.
-- ⚠ 되돌리면 토스 심사 계정(pg_checkout_override)이 mode='reviewer' 에서 NICEPAY 주문을 만들 수 있게 되고, 심사 센터 소속 검증이 사라진다(mode 가 off 인 동안은 영향 없음).
-- 복원 결과 정의 해시가 적용 전 운영 정의와 다르면(또는 현재 정의가 이 파일 적용본이 아니면) 아무것도 바꾸지 않고 중단한다.
begin;
do $$
declare
    r record; v_def text; v_new text; v_h text; v_mode text; v_inflight int;
begin
    select mode into v_mode from nicepay_checkout_gate where id;
    if v_mode is distinct from 'off' then
        raise exception '롤백 중단: NICEPAY 게이트 mode 가 off 가 아니에요(현재 %). 먼저 mode 를 off 로 닫고 진행 중 거래가 없는지 확인하세요.', coalesce(v_mode, 'NULL');
    end if;
    -- 진행 중(승인 선점 후 결과 미확정) NICEPAY 거래가 하나라도 있으면 중단: approving 주문은 아직 승인/취소/release 중 하나로 해소되지 않았다.
    select count(*) into v_inflight from orders where payment_provider = 'nicepay' and status = 'approving';
    if v_inflight > 0 then
        raise exception '롤백 중단: 승인 선점 상태(approving)의 NICEPAY 주문이 %건 있어요. 승인 확정·취소·release 로 모두 해소된 뒤 다시 실행하세요.', v_inflight;
    end if;
    for r in
        select * from (values
            ('public.orders_guard_nicepay_create()', 'b2f340d8d41fc2428e26c7cde3aaafd4', '721bef6e27646547535cfe7b05393f88'),
            ('public.nicepay_claim_order(uuid)',     '4cb7d4ece28db732bd5886088c034609', 'd7145831da2f416612818d2e4fe5d5fc')
        ) as t(sig, pre_md5, post_md5)
    loop
        if to_regprocedure(r.sig) is null then continue; end if;
        v_def := pg_get_functiondef(to_regprocedure(r.sig)); v_h := md5(v_def);
        if v_h = r.pre_md5 then raise notice '%: 이미 적용 전 정의 — 건너뜀', r.sig; continue; end if;
        if v_h <> r.post_md5 then raise exception '% 의 현재 정의가 이 파일 적용본이 아니에요(해시 %) — 덮어쓰지 않고 중단합니다', r.sig, v_h; end if;
        if r.sig like 'public.orders_guard%' then
            v_new := replace(v_def, 'a.nicepay_review_access and nicepay_order_is_review_target(new.center_id, new.product_id)', 'a.pg_checkout_override');
        else
            v_new := replace(v_def, 'ga.nicepay_review_access and nicepay_order_is_review_target(go.center_id, go.product_id)', 'ga.pg_checkout_override');
            v_new := replace(v_new, 'accounts.nicepay_review_access + 심사 센터 주문', 'accounts.pg_checkout_override');
        end if;
        execute v_new;
        if md5(pg_get_functiondef(to_regprocedure(r.sig))) <> r.pre_md5 then
            raise exception '% 복원 결과 정의 해시가 적용 전 운영 정의와 달라요 — 트랜잭션 전체를 롤백합니다', r.sig;
        end if;
    end loop;
end $$;
drop function if exists public.nicepay_order_is_review_target(uuid, uuid);
commit;
```

## 부록 A. 심사 종료 SQL (6개 파일 외)

### A. `close_nicepay_review_20261029.sql` — 부록
- 설명: 심사 종료 후 권한 해제·게이트 off·센터 비공개
- 줄 수: 43 · SHA-256: `34386b16c7cf423f49416c046a51530385a9272fad791b6c5a541b37b6d5c2b4`

```sql
-- ============================================================
-- NICEPAY 심사 종료 절차(2026-10-29) — 검토용 초안, 운영 미실행. 심사가 끝나면 SQL Editor 에서 위에서 아래로 실행한다.
-- 목적: 심사관 전용 권한을 해제하고, NICEPAY 결제 게이트를 닫고, 심사 센터를 일반 회원에게 보이지 않게 닫는다. 데이터는 삭제하지 않는다.
-- 순서가 중요하다: 센터를 먼저 닫은 뒤에만 분리 SQL 을 롤백할 수 있다(롤백 스크립트는 공개 가능한 심사 센터가 있으면 중단한다).
-- 이 파일이 바꾸는 것(실행 순서): ① 게이트 off ② 진행 중 승인(approving) 확인(알림만) ③ 심사관 권한 해제 ④ 심사 센터 비공개(is_internal=true — centers.status 는 플랫폼 관리자만 바꿀 수 있어 SQL Editor 로는 못 바꿈) ⑤ 남은 대기 주문 취소 ⑥ 일반 회원 노출 관계 확인(파일 끝 확인 쿼리).
-- 한 트랜잭션이라 중간에 실패하면 게이트·권한·센터·주문이 모두 원래대로 돌아온다. 반복 실행해도 안전하다(이미 닫힌 상태면 0건 갱신).
-- ⚠ 심사 센터에 일반 회원 관계(center_members 등)가 남아 있으면, 센터를 닫아도 P2 분리 정책을 롤백하는 순간 그 회원에게 심사 센터가 보인다(기존 센터 조회 정책: 내부 센터도 등록 회원에게 허용). 그 경우 P2 롤백 SQL 이 스스로 중단한다. 관계 데이터는 이 파일이 지우지 않는다.
-- 바꾸지 않는 것: 기존 운영 센터·상품·주문·수강권·예약, 토스 심사 계정(pg_checkout_override), 심사 중 생긴 주문·수강권·결제 기록(보존 — 환불은 기존 환불 절차).
-- ============================================================
begin;
-- ① NICEPAY 결제 게이트 닫기(신규 주문 생성·승인 선점 거부. 진행 중 거래의 마무리·취소·환불은 계속 가능) — 가장 먼저 닫아 이후 단계 동안 새 승인 선점이 시작되지 않게 한다
update nicepay_checkout_gate set mode = 'off', updated_at = now() where id;
-- ② 진행 중 승인 확인(알림만, 중단하지 않음): approving 주문은 승인/취소/release 로 해소돼야 하며 이 파일은 건드리지 않는다. 남아 있으면 P2b 롤백도 중단된다.
do $$ declare n int; begin select count(*) into n from orders where payment_provider = 'nicepay' and status = 'approving'; if n > 0 then raise notice '진행 중(approving) NICEPAY 주문 %건 — 해소(승인 확정·취소·release)된 뒤에 P2b/P2 롤백을 진행하세요.', n; end if; end $$;
-- ③ 심사관 전용 권한 해제 (이 컬럼은 NICEPAY 전용 — 토스 심사 계정의 pg_checkout_override 는 건드리지 않는다)
update accounts set nicepay_review_access = false where nicepay_review_access;
-- ④ 심사 센터 비공개: 일반 회원·비회원·옛 심사관 누구에게도 보이지 않는다(센터 하나를 닫으면 상품·수업 직접 조회도 막힌다)
update centers set is_internal = true where is_nicepay_review;
-- ⑤ 심사 센터의 미결제 대기 주문 정리. 진행 중인 결제·승인 선점에는 영향을 주지 않는다:
--    · NICEPAY 승인 선점(nicepay_claim_order)은 주문을 pending → approving 으로 바꾸고, 승인 결과 불명 검토(pg_review_at)·PG 거래번호(pg_tid)도 approving 상태에 붙는다.
--      아래 조건은 status = 'pending' 이고 선점·거래·검토 흔적(pg_claim_id·pg_tid·pg_review_at)이 전혀 없는 주문만 고른다 → approving/paid/done 은 건드리지 않는다.
--    · ① 에서 게이트를 이미 off 로 닫았으므로 새 승인 선점은 시작되지 않는다. 같은 행을 동시에 선점하려는 트랜잭션과는 행 잠금으로 직렬화되고, 선점이 먼저면 이 UPDATE 의 status 조건이 다시 평가돼 건너뛴다.
--    · 직접결제(direct) 대기 주문은 센터 확인 전 주문이라 같이 정리된다(결제 완료·확인된 주문은 status 가 달라 제외).
update orders set status = 'cancelled'
 where status = 'pending' and pg_claim_id is null and pg_tid is null and pg_review_at is null
   and center_id in (select id from centers where is_nicepay_review);
commit;

-- 확인(읽기 전용) — 모두 기대값이어야 한다
select
  (select count(*) from accounts where nicepay_review_access)                                   as reviewers_must_be_0,
  (select mode from nicepay_checkout_gate where id)                                              as gate_mode_must_be_off,
  (select count(*) from centers where is_nicepay_review and not is_internal and status = 'approved') as publicly_visible_review_centers_must_be_0,
  (select count(*) from orders where status = 'pending' and pg_claim_id is null and pg_tid is null and pg_review_at is null and center_id in (select id from centers where is_nicepay_review)) as pending_review_orders_must_be_0,
  (select count(*) from orders where status = 'approving' and center_id in (select id from centers where is_nicepay_review)) as in_flight_approving_orders_info,   -- 0 이 아니면 진행 중 승인이 끝난 뒤(approving 이 해소된 뒤) 롤백을 진행한다
  (select count(*) from accounts where pg_checkout_override)                                     as toss_override_accounts_unchanged;
-- 심사 중 생긴 결제 기록(참고): 환불·보존 판단용
select o.status, count(*) from orders o join centers c on c.id = o.center_id where c.is_nicepay_review group by 1 order by 1;
-- ⑥ 일반 회원 노출 관계(읽기 전용): 0 이 아니면 P2 분리 정책 롤백이 차단된다(권장: 롤백하지 않고 P2 를 그대로 둔다. 롤백이 필요하면 관계 정리 방법을 먼저 승인받는다).
select
  (select count(*) from center_members cm join centers c on c.id = cm.center_id where c.is_nicepay_review) as review_center_member_rows_block_p2_rollback_if_nonzero,
  (select count(*) from memberships m join centers c on c.id = m.center_id where c.is_nicepay_review) as review_center_memberships_info,
  (select count(*) from manager_centers mc join centers c on c.id = mc.center_id where c.is_nicepay_review) as review_center_manager_rows_info_intended_access;
```

## 부록 B. 롤백 준비 확인 SQL (읽기 전용)

### B. `check_nicepay_review_rollback_readiness_20261030.sql` — 부록
- 설명: 심사 센터의 회원 관계·진행 중 승인·P2b 잔존 여부 확인(변경 없음)
- 줄 수: 22 · SHA-256: `69f27db98cc5fdeea3b946dc1e343b8f79f47dfc1e0829bccc8ea0c7157f9283`

```sql
-- ============================================================
-- NICEPAY P2 롤백 준비 상태 확인(읽기 전용 · 2026-10-30) — 변경 없음. SQL Editor 에서 close_nicepay_review_20261029.sql 실행 뒤, rollback_add_nicepay_review_center_isolation_20261028.sql 실행 전에 본다.
-- 목적: 심사 센터에 일반 회원 관계가 남아 있어 P2 분리 정책을 지우면 그 회원에게 심사 센터가 보이게 되는지 미리 확인한다.
--   (실제 가시성 측정은 롤백 SQL 이 직접 하고, 늘어난 계정이 있으면 스스로 중단한다. 이 파일은 그 이유를 미리 보여 주는 용도.)
-- 판정: ① 이 값들이 모두 0 이면 롤백이 노출을 늘리지 않을 가능성이 높다. ② 0 이 아니면 회원·프로필·주문·수강권·예약을 지우지 말고, P2 를 그대로 두는 것을 권장한다(일반 사용자에게는 이미 보이지 않는다).
-- ============================================================
select
  (select count(*) from centers where is_nicepay_review and not is_internal and status = 'approved')                           as publicly_visible_review_centers_must_be_0,
  (select count(*) from center_members cm join centers c on c.id = cm.center_id where c.is_nicepay_review)                       as center_member_rows_must_be_0,
  (select count(*) from memberships m join centers c on c.id = m.center_id where c.is_nicepay_review)                            as memberships_info,
  (select count(*) from orders o join centers c on c.id = o.center_id where c.is_nicepay_review)                                 as orders_info,
  (select count(*) from cart_items x join centers c on c.id = x.center_id where c.is_nicepay_review)                             as cart_items_info,
  (select count(*) from purchase_requests x join centers c on c.id = x.center_id where c.is_nicepay_review)                      as purchase_requests_info,
  (select count(*) from reservations r join classes cl on cl.id = r.class_id join centers c on c.id = cl.center_id where c.is_nicepay_review) as reservations_info,
  (select count(*) from manager_centers mc join centers c on c.id = mc.center_id where c.is_nicepay_review)                      as manager_rows_info_intended_access,
  (select count(*) from orders where payment_provider = 'nicepay' and status = 'approving')                                       as in_flight_approving_orders_must_be_0,
  (select mode from nicepay_checkout_gate where id)                                                                               as gate_mode_must_be_off,
  to_regprocedure('public.nicepay_order_is_review_target(uuid,uuid)') is not null                                                  as p2b_still_applied_rollback_p2b_first;
-- 롤백을 막을 수 있는 계정(식별자만): 심사 센터에 회원 등록이 있는 계정
select cm.center_id, p.account_id, cm.profile_id, cm.registered_at
  from center_members cm join centers c on c.id = cm.center_id and c.is_nicepay_review join profiles p on p.id = cm.profile_id
 order by cm.registered_at limit 50;
```
