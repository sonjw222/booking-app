# NICEPAY 운영 SQL 최종 검토 패키지 (NICEPAY_SQL_FINAL_REVIEW)

- 기준: 브랜치 `feat/nicepay-review-integrated-20261029`, 커밋 `c1022febebdb48a66e9bb20ee4e91a60c862d8b2` (이 문서만 추가한 커밋은 그 위)
- 이 문서는 아래 6개 SQL 파일을 **원문 그대로(생략·수정 없음)** 묶었다. 각 파일의 SHA-256 을 적어 두었으니 저장소 파일과 대조할 수 있다.
- **어떤 SQL 도 운영·공유 DEV 에서 실행하지 않았다.** 운영은 읽기 전용(SELECT)으로만 조회했고, 파괴·실패 주입 시험은 모두 로컬 일회용 Supabase 에서만 했다. 기존 SQL·앱 코드는 이 작업에서 수정하지 않았다.
- 작성 시점의 운영 상태(읽기 전용 조회): 게이트 `mode=off`, 센터 7(내부 4)·상품 62·수업 59·주문 22·수강권 24·예약 19·계정 22, `pg_checkout_override=true` 계정 1(토스 심사 계정), 분리 SQL 미적용. P0 함수 정의 해시 3/3 일치·P0b 7/7 true(`docs/payments/NICEPAY_PREFLIGHT_20261029.md`).

## 1. 결론(독립 재확인 요약)
| 질문 | 결론 | 근거(§4) |
|---|---|---|
| 기존 운영 센터·상품·주문 데이터를 바꾸는가 | **아니오** — 어떤 SQL 에도 기존 테이블 행을 INSERT/UPDATE/DELETE 하는 문장이 없다. 컬럼 2개 추가(기본값 false)와 객체 추가·함수 교체뿐 | 정적 검사 + 로컬 데이터 지문 동일 |
| 기존 토스 심사 계정에 영향이 있는가 | **없음** — P2 실행 코드는 `pg_checkout_override` 를 참조하지 않고, P2b 는 NICEPAY 게이트 함수 2개 안의 문자열만 바꾼다. 토스 계정의 센터 접근·`pg_checkout_override` 값 불변 | 정적 검사 + 로컬 매트릭스 |
| NICEPAY 전용 권한이 분리되는가 | **예** — `accounts.nicepay_review_access`(운영자만 변경)만 심사관 판정·게이트에 쓰인다. 토스 심사 계정은 NICEPAY 게이트에서 거부 | 로컬 게이트 매트릭스(패치 전엔 통과하던 구멍이 패치 후 거부) |
| 기존 운영 함수 교체의 영향 | **행동 불변(심사 센터·심사관 없을 때)** — 교체 3개 모두 현재 운영 정의(해시 일치) + 조건 1개 추가이고, 모든 기존 센터에서 추가 조건은 항상 참. 권한(ACL)·SECURITY DEFINER·search_path 동일 | §4-4 |
| 실행 도중 실패하면 원자적으로 롤백되는가 | **예** — 두 SQL 모두 `BEGIN…COMMIT` 단일 트랜잭션. 실패 주입(P2 중간·끝, P2b 두 번째 함수) 시 잔여물 0, 기존 함수 정의 불변(로컬) | §4-5 |
| 검증 실패 시 중단 조건 | §5 표 — 기대값 하나라도 다르면 **다음 단계(P2b·시드·심사관 지정)로 진행하지 않고 롤백 검토** | §5 |
| 심사 종료 후 센터 비공개 | **가능·검증됨** — `close_nicepay_review_20261029.sql` 후 익명/일반 직접 조회 0, 이후에만 P2 롤백 허용 | §6 |

## 2. 파일 목록과 실행 순서
| 순서 | 구분 | 파일 | 줄 수 | SHA-256 | 역할 |
|---|---|---|---|---|---|
| 1 | P2 | `add_nicepay_review_center_isolation_20261028.sql` | 319 | `b00dffc428be73b9…` | 센터 분리 본체 + 전용 권한 컬럼 |
| 2 | V-P2 | `verify_add_nicepay_review_center_isolation_20261028.sql` | 33 | `a349e680cbdc3916…` | P2 적용 후 읽기 전용 검증 |
| 3 | P2b | `fix_nicepay_gate_reviewer_flag_20261029.sql` | 33 | `2fbc991b31c6125a…` | 운영에 적용된 NICEPAY 게이트 함수 2개의 심사관 판별을 전용 권한으로 치환 |
| 4 | V-P2b | `verify_fix_nicepay_gate_reviewer_flag_20261029.sql` | 6 | `13c6a94793cee7ee…` | P2b 적용 후 읽기 전용 검증 |
| 롤백-1 | RB-P2b | `rollback_fix_nicepay_gate_reviewer_flag_20261029.sql` | 13 | `56979c1c0ab9e002…` | P2b 롤백(역치환) |
| 롤백-2 | RB-P2 | `rollback_add_nicepay_review_center_isolation_20261028.sql` | 183 | `c712ac6370032cd3…` | P2 롤백(공개 가능한 심사 센터가 있으면 중단) |
| 심사 종료 | 부록 A | `close_nicepay_review_20261029.sql` | 27 | `1539be9bebdac24f…` | 심사 종료 후 권한 해제·게이트 off·센터 비공개 (6개 파일 외, 종료 절차 설명용) |

(전체 SHA-256 는 각 SQL 전문 절 머리에 있다.) 사전 점검(P0)·시드(P3)·심사관 지정은 이 6개 파일에 포함되지 않는다: P0 = `preflight_nicepay_review_center_isolation_20261028.sql`(읽기 전용, 운영에서 이미 실행·통과), P3 = `seed_nicepay_review_center_20261028.sql`(별도 승인·값 확정 필요), 심사관 지정 = `update accounts set nicepay_review_access = true where auth_id = (select id from auth.users where email = 'sonjw222@naver.com');`(별도 승인).

**순서 규칙**: P2 → V-P2(통과 확인) → P2b → V-P2b(통과 확인) → (별도 승인) 시드 → (별도 승인) 심사관 지정. 심사관 지정은 반드시 P2b 이후(P2b 전에는 게이트가 토스 계정 기준이라 NICEPAY 심사관이 결제 게이트를 통과하지 못한다). P2b 는 P2 의 컬럼이 없으면 스스로 중단한다. **롤백 순서는 반대**: 심사 센터가 있으면 먼저 닫기 → RB-P2b → RB-P2.

## 3. 각 SQL 의 적용 효과와 영향받는 기존 객체
### P2 — `add_nicepay_review_center_isolation_20261028.sql`
- **추가(신규)**: 컬럼 2(`centers.is_nicepay_review`, `accounts.nicepay_review_access`, 둘 다 `not null default false`), 함수 7(`nicepay_is_reviewer`, `nicepay_review_center_allowed`, `nicepay_review_center_member_allowed`, `nicepay_class_has_my_reservation`, `nicepay_review_guard_center`, `enforce_center_nicepay_review_admin_only`, `enforce_nicepay_review_access_admin_only`), 정책 4(centers/classes/products 제한 정책 3 + classes 허용 정책 1), 트리거 12(accounts 1·centers 1·orders/memberships/cart_items/purchase_requests 각 INSERT·UPDATE 2 = 8·reservations INSERT·UPDATE 2).
- **교체(기존 함수, 운영 정의 해시 일치 확인됨)**: `center_rows_visible`(기존 조건 5개를 괄호로 묶고 `AND nicepay_review_center_allowed(...)`), `fetch_public_storefront_products`·`fetch_purchasable_products`(각 `where` 에 1줄 추가), `fetch_public_storefront_product_periods`(운영에는 없음 → **새로 생성**하고 함수 주석에 생성 표식을 남김).
- **기존 정책은 대체하지 않는다**: 기존 허용 정책("승인된 센터 조회" 등)은 그대로 두고 제한(restrictive) 정책을 겹친다.
- **효과**: 심사 센터(`is_nicepay_review=true`)는 NICEPAY 심사관·해당 센터 매니저·플랫폼 관리자에게만 보이고, NICEPAY 심사관에게는 심사 센터만 보인다(관리 화면용 매니저 읽기 예외는 유지). 구매·예약·수강권·장바구니·구매신청은 행이 가리키는 모든 센터(center_id·상품의 실제 센터·수업·수강권)를 트리거가 검사한다. 현재 운영에는 심사 센터도 심사관도 없으므로 **적용 직후 사용자에게 보이는 변화는 없다.**
### P2b — `fix_nicepay_gate_reviewer_flag_20261029.sql`
- **교체(기존 함수, 제자리 치환)**: `orders_guard_nicepay_create()`(코드 1곳), `nicepay_claim_order(uuid)`(코드 1곳+주석 1곳) 안의 `pg_checkout_override` → `nicepay_review_access`. 정의 전체를 다시 쓰지 않고 운영의 현재 정의에서 문자열만 바꾼다(치환 위치가 예상과 다르면 중단, 이미 바뀌었으면 건너뜀=멱등).
- **효과**: 게이트 mode 가 `reviewer` 일 때 NICEPAY 주문 생성·승인 선점을 전용 권한 계정만 통과. **현재 mode=off 이므로 적용 직후 동작 차이 없음.**
### 검증·롤백
- V-P2: 컬럼 2·함수 7·제한 정책 3·허용 정책 1·트리거 12·목록 RPC 3 교체·`center_rows_visible` 교체·PUBLIC 실행 불가 4 + 기존 센터/상품 수 + 심사 센터/심사관/토스 override 계정 수. V-P2b: 두 함수가 새 플래그를 보고 옛 플래그는 안 보는지.
- RB-P2b: 두 함수의 `nicepay_review_access` → `pg_checkout_override` 역치환. RB-P2: 정책·트리거·신규 함수 삭제, 기존 함수 3개를 적용 전 정의로 복원, 기간 RPC 는 P2 가 만든 것이면 삭제(함수 주석 표식)·이전부터 있었으면 복원. **컬럼 2개와 `accounts` 보호 트리거는 데이터 보존을 위해 남긴다.** 공개 가능한 심사 센터(승인·비내부)가 있으면 아무것도 바꾸지 않고 중단.

## 4. 독립 재확인
### 4-1. 기존 운영 센터·상품·주문 데이터 변경 여부 — 변경 없음
- 정적: 6개 파일의 실행 코드(주석 제외)에 대해 `insert into / update / delete from / truncate / drop table / drop column` 을 검사 — **기존 업무 테이블을 대상으로 하는 DML 없음**. 유일한 `ALTER TABLE` 은 `add column if not exists … not null default false` 2건(PostgreSQL 11+ 에서 상수 기본값은 행을 다시 쓰지 않는 메타데이터 변경). `drop` 은 P2/RB 가 자기가 만든 정책·트리거·함수만 지운다.
- 동적(로컬, 운영과 같은 함수 정의에서 시작): 센터·상품·수업·주문·수강권·예약·계정·매니저 관계의 지문이 **P2+P2b 적용 전후 동일**(`98e1236c…` = `98e1236c…`), 시드 후에도 심사 센터 행 외 불변, 닫기·롤백 후에도 동일.
- 주의: 운영 `accounts`·`centers` 에 컬럼이 추가되므로 `select *` 결과 열이 2개 늘어난다(앱은 명시 컬럼 조회라 영향 없음, 단 컬럼 전체 덤프/동기화 도구가 있다면 확인).
### 4-2. 기존 토스 심사 계정 영향 — 없음
- P2 실행 코드에 `pg_checkout_override` 참조 없음(주석·COMMENT 문구만 — 정적 계약 테스트가 강제). P2b 는 NICEPAY 전용 게이트 함수 2개만 건드린다(토스 결제 경로 아님).
- 운영에는 `pg_checkout_override=true` 계정이 1개(토스 심사 계정, 회원). 로컬 매트릭스(토스 심사관 페르소나): 센터 목록·운영/토스 센터 주문 가능은 **변경 없음**, 심사 센터 불가, NICEPAY 게이트 거부.
- 부수 효과 한 가지(의도된 것): 게이트가 토스 플래그를 더는 보지 않으므로, P2b 이후 `mode=reviewer` 에서 토스 심사 계정은 NICEPAY 주문을 만들 수 없다(이전엔 운영 센터 상품으로도 가능했던 구멍).
### 4-3. NICEPAY 전용 권한 분리
- 판정 함수 `nicepay_is_reviewer()` 는 `accounts.nicepay_review_access` 만 본다(`my_account_id()` 기준, 이메일 비사용). 값 변경은 보호 트리거로 **플랫폼 관리자 또는 SQL Editor(auth.uid() is null)만** 가능 — 회원 본인이 켤 수 없다(로컬 시험: 거부).
- 게이트: P2b 후 두 함수 모두 새 플래그 사용·옛 플래그 미사용(V-P2b 로 운영에서 확인). 게이트 매트릭스(로컬): reviewer 모드에서 일반 회원·토스 심사관 거부, NICEPAY 심사관은 심사 센터 상품만 통과, 운영 상품은 거부.
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
{tr1.strip()}
```
- 결과: P2 중간·끝 실패 시 컬럼·함수·트리거·정책 **잔여물 0/0/0/0**, 기존 함수 5개 정의 해시 불변. P2b 는 P2 없이 실행하면 즉시 중단, 두 번째 함수 처리 중 실패해도 첫 번째 함수까지 원복. 정상 적용 후 재실행(멱등)은 변화 없음.
- 한계: 이 보장은 **스크립트 전체가 한 번의 요청/세션으로 실행될 때**의 PostgreSQL 동작이다. 편집기·도구가 문장을 쪼개 따로 실행하면 일부만 적용될 수 있으므로, 파일 전체를 한 번에 실행하고 반드시 실행 후 검증을 확인한다(편집기별 동작은 이 환경에서 확인하지 못했다).
### 4-6. 실행 후 검증 실패 시 중단 조건
§5 참조. 하나라도 기대값과 다르면 **다음 단계로 진행하지 않는다**.
### 4-7. 심사 종료 후 센터 비공개
§6 참조.

## 5. 중단(STOP) 조건 — 실행 후 검증 기대값
| 단계 | 검증 | 기대값 | 다르면 |
|---|---|---|---|
| P2 직후 | V-P2 1번 쿼리 | `columns_must_be_2=2`, `new_functions_must_be_7=7`, `restrictive_policies_must_be_3=3`, `own_reservation_policy_must_be_1=1`, `triggers_must_be_12=12`, `list_rpcs_replaced_must_be_3=3`, `center_rows_visible_replaced_must_be_true=t`, `helpers_executable_by_public_must_be_0=0` | **STOP** — P2b·시드·심사관 지정 금지, 원인 확인 후 RB-P2 검토 |
| P2 직후 | V-P2 2번 쿼리 | `existing_centers`·`existing_products` 가 적용 전에 기록한 값과 같음(현재 운영 7 / 62 에서 심사 센터 0) | STOP — 기존 데이터 변경 의심 |
| P2 직후 | V-P2 3번 | `review_centers=0`, `nicepay_reviewer_accounts=0`, `toss_override_accounts_unchanged=1` | STOP |
| P2b 직후 | V-P2b | 두 행 모두 `uses_new_flag=t`, `still_uses_old_flag_must_be_false=f` | STOP — RB-P2b |
| 적용 직후 앱 | 일반 회원 로그인 후 홈·상품·구매 화면 | 평소와 동일, 오류 없음 | STOP — 롤백 검토 |
| 시드 후(별도 승인) | V-P2 3번 | `review_centers=1`; 익명/일반 계정에서 심사 센터·상품 0건 | 일반에 보이면 즉시 `update centers set is_internal = true where is_nicepay_review;` 후 원인 확인 |
| 심사관 지정 후(별도 승인) | V-P2 3번 | `nicepay_reviewer_accounts=1`, `toss_override_accounts_unchanged=1` | 즉시 지정 해제(`= false`) |

## 6. 롤백 순서와 NICEPAY 심사 종료
1. **심사 종료 절차** `close_nicepay_review_20261029.sql`(부록 A): ① 전용 권한 해제 ② 게이트 `off` ③ 심사 센터 `is_internal=true`(`centers.status` 는 보호 트리거 때문에 SQL Editor 로 변경 불가·플랫폼 관리자만 가능하므로 `is_internal` 사용) ④ 심사 센터의 대기 주문 취소. 기존 센터·상품·주문(결제 완료)·토스 계정 불변. 심사 중 생긴 주문·수강권은 보존(환불은 기존 절차).
2. **P2 롤백 전제**: 공개 가능한 심사 센터(승인·비내부)가 있으면 RB-P2 가 중단한다 → 먼저 위 ③ 로 센터를 닫는다. 센터 하나를 닫으면 그 센터의 상품·수업 직접 조회도 같이 막힌다(기존 "상품 조회"/"승인된 센터 수업 조회" 정책이 승인된 비내부 센터만 허용).
3. **RB-P2b → RB-P2** 순서(P2b 가 P2 의 컬럼에 의존하므로 역순).
로컬 확인:
```
{tr3.strip()}
```
- 분리 SQL 없이 공개 가능한 심사 센터가 있으면 익명이 센터 1·상품 3 을 직접 조회(위험, A0) → P2 적용으로 0 → 센터를 닫으면 0 → 닫은 뒤 RB-P2b·RB-P2 후에도 0(A3). 롤백 안전장치 시나리오(공개 상태 중단, 기간 RPC 이전 존재 여부별 삭제/복원 4종) 11/11 통과(`scripts/isolated/nicepayReview/rollbackScenarios.mjs`).

## 7. 이 검토에서 확인하지 못한 것(솔직한 한계)
- 운영 편집기/도구가 스크립트를 한 트랜잭션으로 실행하는지(로컬은 psql 단일 입력 기준).
- 운영에서의 실제 잠금 대기 시간(규모가 작아 영향이 적다고 판단하나 측정하지 않음).
- 운영 앱에서의 화면 확인(운영 로그인·구매 금지). 운영 함수 정의는 해시 3개로 확인했으나 P2b 의 두 함수 정의는 해시가 아니라 "치환 위치 개수"로만 확인(운영 조회: 코드 1곳 / 2곳).
- NICEPAY 쪽 사항(MID·키 계열·심사 전용 센터 허용·샌드박스)은 SQL 과 무관하며 회신 대기 중.

## 8. SQL 전문(원문 그대로)

### 1. `add_nicepay_review_center_isolation_20261028.sql` — P2
- 설명: 센터 분리 본체 + 전용 권한 컬럼
- 줄 수: 319 · SHA-256: `b00dffc428be73b926e470aa199c9f491bc8d0d6d5b53447590206483a4b84f4`

```sql
-- ============================================================
-- NICEPAY 카드사 심사 전용 센터 분리 (2026-10-28) — 검토용 초안, 로컬 격리 DB 에서만 실행·검증했다. 운영/공유 DEV 미실행.
--
-- 목적: NICEPAY 심사 전용 센터·수강권을 만들어도
--   · 일반 회원/비회원에게는 그 센터·수업·상품이 어떤 경로로도 보이지 않고(목록·직접 URL·RPC·구매·예약),
--   · NICEPAY 심사관 계정(accounts.nicepay_review_access = true — 신규 전용 권한. 기존 토스 심사용 pg_checkout_override 와 완전히 별개)에게는 심사 센터만 보이고 기존 운영 센터는 보이지 않게 한다.
--     기존 토스 심사 계정(pg_checkout_override)은 이 SQL 로 아무 영향도 받지 않는다.
--   기존 센터·상품·주문·수강권·예약 데이터는 읽기/수정/삭제하지 않는다(행 변경 0). 새 컬럼 2개(centers.is_nicepay_review, accounts.nicepay_review_access) + 함수 7개 + 정책 4개 + 트리거 12개 + 기존 함수 3~4개 정의 교체(center_rows_visible, 목록 RPC 2개, 선택적 기간 RPC).
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

-- preflight: 전제 객체가 없으면 중단(부분 적용 방지)
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

-- NICEPAY 심사관 전용 권한(토스 심사용 pg_checkout_override 와 별개). 운영자만 변경 가능(본인이 스스로 켤 수 없음) — SQL Editor(auth.uid() is null) 또는 플랫폼 관리자만.
alter table accounts add column if not exists nicepay_review_access boolean not null default false;
comment on column accounts.nicepay_review_access is 'NICEPAY 카드사 심사관 전용 권한. true 이면 심사 센터만 보이고 NICEPAY 결제 게이트를 통과한다. pg_checkout_override(토스 심사용)와 독립.';
create or replace function enforce_nicepay_review_access_admin_only()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.nicepay_review_access is distinct from old.nicepay_review_access then
    if auth.uid() is not null and not is_platform_admin() then raise exception '이 값은 운영자만 변경할 수 있어요'; end if;
  end if;
  return new;
end $$;
drop trigger if exists trg_accounts_nicepay_review_access_admin_only on accounts;
create trigger trg_accounts_nicepay_review_access_admin_only before update on accounts
  for each row execute function enforce_nicepay_review_access_admin_only();

alter table centers add column if not exists is_nicepay_review boolean not null default false;
comment on column centers.is_nicepay_review is 'NICEPAY 카드사 심사 전용 센터. true 이면 NICEPAY 심사관 계정(accounts.nicepay_review_access)과 해당 센터 매니저/플랫폼 관리자에게만 보인다.';

-- 이 값은 운영자(플랫폼 관리자)/SQL Editor(auth.uid() is null)만 바꿀 수 있다 — 센터 매니저가 자기 센터를 심사 센터로 바꾸거나 심사 센터를 만들 수 없다.
create or replace function enforce_center_nicepay_review_admin_only()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (tg_op = 'INSERT' and new.is_nicepay_review) or (tg_op = 'UPDATE' and new.is_nicepay_review is distinct from old.is_nicepay_review) then
    if auth.uid() is not null and not is_platform_admin() then
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
-- 그래서 행이 가리키는 "모든" 센터(행의 center_id + 상품의 실제 센터 + 수업의 센터 + 수강권의 센터)가 호출자에게 허용된 센터인지 테이블 트리거로 확인한다.
-- 클라이언트가 보낸 center_id 만 믿지 않는다. auth.uid() is null(서버/service_role)은 통과. UPDATE 는 해당 컬럼이 실제로 바뀔 때만 검사한다.
create or replace function nicepay_review_guard_center()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_centers uuid[] := '{}'; v_c uuid; v_row jsonb := to_jsonb(new);
begin
  if auth.uid() is null then return new; end if;
  if tg_table_name = 'reservations' then
    select c.center_id into v_c from classes c where c.id = (v_row->>'class_id')::uuid;
    if v_c is not null then v_centers := v_centers || v_c; end if;
    select m.center_id into v_c from memberships m where m.id = (v_row->>'membership_id')::uuid;
    if v_c is not null then v_centers := v_centers || v_c; end if;
  else
    if (v_row->>'center_id') is not null then v_centers := v_centers || (v_row->>'center_id')::uuid; end if;
    select p.center_id into v_c from products p where p.id = (v_row->>'product_id')::uuid;
    if v_c is not null then v_centers := v_centers || v_c; end if;
  end if;
  foreach v_c in array v_centers loop
    if not nicepay_review_center_member_allowed(v_c) then raise exception '이 센터의 상품·수업은 이용할 수 없어요'; end if;
  end loop;
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
- 줄 수: 33 · SHA-256: `2fbc991b31c6125a45336500cc873b6ca5cb5cb2a718fdab74c277ef3b33db9f`

```sql
-- ============================================================
-- NICEPAY 결제 게이트의 "심사관" 판별을 전용 권한(accounts.nicepay_review_access)으로 변경(2026-10-29) — 검토용 초안, 운영 미실행.
--
-- 배경: 운영에 이미 적용된 두 함수가 mode='reviewer' 일 때 심사관을 accounts.pg_checkout_override(토스 심사용)로 판별한다.
--   · orders_guard_nicepay_create()  — 20261017134256_add_nicepay_checkout_gate_20261017 (NICEPAY 대기 주문 생성 트리거)
--   · nicepay_claim_order(uuid)      — 20261017151331_add_nicepay_provider_support_20261016_v8 (승인 선점)
--   NICEPAY 전용 권한을 분리하면(B안) 토스 심사 계정(override=true)이 실제 센터에서 NICEPAY 주문을 만들 수 있는 구멍이 남는다 → 두 함수의 판별을 새 권한으로 바꾼다.
-- 방식: 운영의 현재 함수 정의(pg_get_functiondef)를 읽어 `pg_checkout_override` 를 `nicepay_review_access` 로 제자리 치환(함수 통째 덮어쓰기 금지).
--   치환 위치가 예상(코드 1곳 이상, 총 3곳 이하)이 아니면 예외로 중단, 이미 바뀌었으면 건너뜀(멱등). 다른 로직은 한 글자도 바꾸지 않는다.
-- 전제: add_nicepay_review_center_isolation_20261028.sql 이 먼저 적용돼 accounts.nicepay_review_access 가 있어야 한다(없으면 중단).
-- 영향: mode 가 'off'(현재 기본)이면 동작 차이 없음. 'reviewer' 모드에서 NICEPAY 주문 생성·승인 선점이 nicepay_review_access 계정에만 허용된다. 'public' 모드는 영향 없음.
-- 롤백: rollback_fix_nicepay_gate_reviewer_flag_20261029.sql(역치환). 검증: verify_fix_nicepay_gate_reviewer_flag_20261029.sql(읽기 전용).
-- ============================================================
begin;
do $$
declare
    v_sig text; v_def text; v_new text; v_n int; v_code int;
begin
    if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='accounts' and column_name='nicepay_review_access') then
        raise exception 'accounts.nicepay_review_access 가 없어요 — add_nicepay_review_center_isolation_20261028.sql 을 먼저 적용하세요';
    end if;
    foreach v_sig in array array['public.orders_guard_nicepay_create()', 'public.nicepay_claim_order(uuid)'] loop
        if to_regprocedure(v_sig) is null then raise exception '% 가 없어요 — NICEPAY 게이트/지원 SQL 이 적용돼 있어야 해요', v_sig; end if;
        select pg_get_functiondef(to_regprocedure(v_sig)) into v_def;
        v_n := (length(v_def) - length(replace(v_def, 'pg_checkout_override', ''))) / length('pg_checkout_override');
        v_code := (length(v_def) - length(replace(v_def, '.pg_checkout_override', ''))) / length('.pg_checkout_override');
        if v_n = 0 and position('nicepay_review_access' in v_def) > 0 then raise notice '%: 이미 전용 권한으로 바뀜 — 건너뜀', v_sig; continue; end if;
        if v_code < 1 or v_n > 3 then raise exception '% 정의가 예상과 달라요(pg_checkout_override 총 %곳 / 코드 %곳) — 중단', v_sig, v_n, v_code; end if;
        v_new := replace(v_def, 'pg_checkout_override', 'nicepay_review_access');
        execute v_new;
    end loop;
end $$;
commit;
```

### 3. `verify_add_nicepay_review_center_isolation_20261028.sql` — V-P2
- 설명: P2 적용 후 읽기 전용 검증
- 줄 수: 33 · SHA-256: `a349e680cbdc3916382a9ae453908a262b056d3859e86cada1340106be3f37df`

```sql
-- 읽기 전용 확인(SQL Editor/postgres 로 실행 — 변경 없음). 역할별 가시성은 아래 "역할 시뮬레이션"으로 확인한다.
-- 1) 객체
select
  (select count(*) from information_schema.columns where table_schema='public'
     and ((table_name='centers' and column_name='is_nicepay_review') or (table_name='accounts' and column_name='nicepay_review_access'))) as columns_must_be_2,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname='public'
     and p.proname in ('nicepay_is_reviewer','nicepay_review_center_allowed','nicepay_review_center_member_allowed','nicepay_class_has_my_reservation','nicepay_review_guard_center','enforce_center_nicepay_review_admin_only','enforce_nicepay_review_access_admin_only')) as new_functions_must_be_7,
  (select count(*) from pg_policies where policyname='nicepay_review_isolation') as restrictive_policies_must_be_3,
  (select count(*) from pg_policies where policyname='nicepay_own_reservation_class') as own_reservation_policy_must_be_1,
  (select count(*) from pg_trigger where not tgisinternal and tgname ~ '^trg_(centers|accounts|orders|memberships|cart_items|purchase_requests|reservations)_nicepay_review_') as triggers_must_be_12,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname='public'
     and p.proname in ('fetch_public_storefront_products','fetch_purchasable_products','fetch_public_storefront_product_periods')
     and position('nicepay_review_center_member_allowed' in pg_get_functiondef(p.oid)) > 0) as list_rpcs_replaced_must_be_3,
  position('nicepay_review_center_allowed' in pg_get_functiondef('public.center_rows_visible(uuid)'::regprocedure)) > 0 as center_rows_visible_replaced_must_be_true,
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
- 줄 수: 6 · SHA-256: `13c6a94793cee7ee04427c484248cc7cc8cdd5a3c9e27825be1738d5cfa8d18d`

```sql
-- 읽기 전용 확인: 두 함수가 전용 권한을 보는지(둘 다 true, old_flag 는 false 여야 함)
select p.proname,
       position('nicepay_review_access' in pg_get_functiondef(p.oid)) > 0 as uses_new_flag,
       position('pg_checkout_override' in pg_get_functiondef(p.oid)) > 0 as still_uses_old_flag_must_be_false
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname in ('orders_guard_nicepay_create', 'nicepay_claim_order');
```

### 5. `rollback_add_nicepay_review_center_isolation_20261028.sql` — RB-P2
- 설명: P2 롤백(공개 가능한 심사 센터가 있으면 중단)
- 줄 수: 183 · SHA-256: `c712ac6370032cd3d48be87cb2907f0a4765271399f54170843f6ee810c9ae20`

```sql
-- add_nicepay_review_center_isolation_20261028.sql 되돌리기: 정책·트리거·신규 함수 삭제, 함수 4개를 이전 정의로 복원. centers.is_nicepay_review 컬럼과 심사 센터 데이터는 남긴다(데이터 보존).
-- ⚠ 안전장치: 롤백하면 분리 규칙이 사라져 심사 센터·상품·수업이 일반 회원에게 보일 수 있다. 일반 공개 가능 상태(승인된 비내부 심사 센터)가 하나라도 있으면 이 스크립트는 아무것도 바꾸지 않고 중단한다.
--   먼저 심사 센터를 비공개로 돌린다. 센터 하나만 닫으면 그 센터의 상품·수업 직접 조회까지 같이 막힌다(기존 "상품 조회"/"승인된 센터 수업 조회" 정책이 승인된 비내부 센터만 허용).
--   방법 ① SQL Editor: update centers set is_internal = true where is_nicepay_review;   -- 심사 센터 행만. 기존 운영 센터 변경 없음(is_internal 은 별도 보호 트리거가 없다)
--   방법 ② 플랫폼 관리자 계정으로 센터 승인 상태를 되돌림(status 는 guard_center_status_change 트리거가 플랫폼 관리자만 변경 허용 — SQL Editor 의 postgres 로는 변경 불가).
--   그 뒤 이 스크립트를 실행한다. (심사 센터 데이터는 삭제하지 않는다.)
-- 남기는 것: accounts.nicepay_review_access 컬럼·보호 트리거(값이 있을 수 있어 데이터 보존. 완전 제거는 별도 승인), centers.is_nicepay_review 컬럼.
-- 복원 규칙(기간 RPC): 분리 SQL 이 그 함수를 새로 만들었다면(함수 주석 표식) 삭제, 분리 SQL 적용 전부터 있었다면 add_public_storefront_product_periods_20261027.sql 정의로 복원.
BEGIN;
do $$
begin
  if exists (select 1 from information_schema.columns where table_schema='public' and table_name='centers' and column_name='is_nicepay_review')
     and exists (select 1 from centers where is_nicepay_review and status = 'approved' and not is_internal) then
    raise exception '롤백 중단: 일반 사용자에게 공개될 수 있는 심사 센터가 있어요. 먼저 update centers set is_internal = true where is_nicepay_review; 를 실행하세요(또는 플랫폼 관리자가 센터 승인 상태를 되돌리세요).';
  end if;
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
drop function if exists nicepay_review_guard_center();
drop function if exists enforce_center_nicepay_review_admin_only();
drop function if exists nicepay_review_center_member_allowed(uuid);
drop function if exists nicepay_review_center_allowed(uuid);
drop function if exists nicepay_is_reviewer();
COMMIT;
```

### 6. `rollback_fix_nicepay_gate_reviewer_flag_20261029.sql` — RB-P2b
- 설명: P2b 롤백(역치환)
- 줄 수: 13 · SHA-256: `56979c1c0ab9e00252bd08471528acfae7a80d0b818b4982ff6a438e92774049`

```sql
-- fix_nicepay_gate_reviewer_flag_20261029.sql 되돌리기: 두 함수의 심사관 판별을 다시 accounts.pg_checkout_override 로 역치환(그 외 로직 불변).
-- 주의: 되돌리면 토스 심사 계정(override)이 mode='reviewer' 에서 NICEPAY 주문을 만들 수 있다.
begin;
do $$
declare v_sig text; v_def text;
begin
    foreach v_sig in array array['public.orders_guard_nicepay_create()', 'public.nicepay_claim_order(uuid)'] loop
        if to_regprocedure(v_sig) is null then continue; end if;
        select pg_get_functiondef(to_regprocedure(v_sig)) into v_def;
        if position('nicepay_review_access' in v_def) > 0 then execute replace(v_def, 'nicepay_review_access', 'pg_checkout_override'); end if;
    end loop;
end $$;
commit;
```

## 부록 A. 심사 종료 SQL (6개 파일 외)

### A. `close_nicepay_review_20261029.sql` — 부록
- 설명: 심사 종료 후 권한 해제·게이트 off·센터 비공개 (6개 파일 외, 종료 절차 설명용)
- 줄 수: 27 · SHA-256: `1539be9bebdac24fc4f6aa3b7274003cbac4fc9f7a61b3f791580debd8ea91c4`

```sql
-- ============================================================
-- NICEPAY 심사 종료 절차(2026-10-29) — 검토용 초안, 운영 미실행. 심사가 끝나면 SQL Editor 에서 위에서 아래로 실행한다.
-- 목적: 심사관 전용 권한을 해제하고, NICEPAY 결제 게이트를 닫고, 심사 센터를 일반 회원에게 보이지 않게 닫는다. 데이터는 삭제하지 않는다.
-- 순서가 중요하다: 센터를 먼저 닫은 뒤에만 분리 SQL 을 롤백할 수 있다(롤백 스크립트는 공개 가능한 심사 센터가 있으면 중단한다).
-- 이 파일이 바꾸는 것: ① 심사관 권한 해제 ② 게이트 off ③ 심사 센터 비공개(is_internal=true — centers.status 는 플랫폼 관리자만 바꿀 수 있어 SQL Editor 로는 못 바꿈) ④ 남은 대기 주문 취소.
-- 바꾸지 않는 것: 기존 운영 센터·상품·주문·수강권·예약, 토스 심사 계정(pg_checkout_override), 심사 중 생긴 주문·수강권·결제 기록(보존 — 환불은 기존 환불 절차).
-- ============================================================
begin;
-- ① 심사관 전용 권한 해제 (이 컬럼은 NICEPAY 전용 — 토스 심사 계정의 pg_checkout_override 는 건드리지 않는다)
update accounts set nicepay_review_access = false where nicepay_review_access;
-- ② NICEPAY 결제 게이트 닫기(신규 주문 생성·승인 선점 거부. 진행 중 거래의 마무리·취소·환불은 계속 가능)
update nicepay_checkout_gate set mode = 'off', updated_at = now() where id;
-- ③ 심사 센터 비공개: 일반 회원·비회원·옛 심사관 누구에게도 보이지 않는다(센터 하나를 닫으면 상품·수업 직접 조회도 막힌다)
update centers set is_internal = true where is_nicepay_review;
-- ④ 심사 센터의 미결제 대기 주문 정리(결제 완료 건은 건드리지 않는다)
update orders set status = 'cancelled' where status = 'pending' and center_id in (select id from centers where is_nicepay_review);
commit;

-- 확인(읽기 전용) — 모두 기대값이어야 한다
select
  (select count(*) from accounts where nicepay_review_access)                                   as reviewers_must_be_0,
  (select mode from nicepay_checkout_gate where id)                                              as gate_mode_must_be_off,
  (select count(*) from centers where is_nicepay_review and not is_internal and status = 'approved') as publicly_visible_review_centers_must_be_0,
  (select count(*) from orders where status = 'pending' and center_id in (select id from centers where is_nicepay_review)) as pending_review_orders_must_be_0,
  (select count(*) from accounts where pg_checkout_override)                                     as toss_override_accounts_unchanged;
-- 심사 중 생긴 결제 기록(참고): 환불·보존 판단용
select o.status, count(*) from orders o join centers c on c.id = o.center_id where c.is_nicepay_review group by 1 order by 1;
```
