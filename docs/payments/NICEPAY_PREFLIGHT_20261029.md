# NICEPAY 심사 — 운영 반영 전 최종 Preflight (2026-10-29)

통합 브랜치 `feat/nicepay-review-integrated-20261029`, 기준 커밋 `e015793`. **운영에서는 SELECT 만 실행**(`supabase db query --linked`, 각 문장이 `select` 로 시작하고 변경 키워드가 없음을 실행 전 정적 검사). 함수 교체·테이블 변경·계정 수정·데이터 생성 없음. 원본 결과: `docs/qa/nicepay-preflight-20261029/prod-preflight-readonly-results.json`.

## 1. 운영 읽기 전용 결과
| 검사 | 결과 |
|---|---|
| **P0 함수 정의 해시** `center_rows_visible` | 운영 `2be0d758…` = 기대값 → **일치** |
| `fetch_public_storefront_products` | 운영 `fda8e182…` = 기대값 → **일치** |
| `fetch_purchasable_products` | 운영 `675be9c7…` = 기대값 → **일치** |
| 전제(my_account_id·my_managed_center_ids·is_platform_admin·`accounts.pg_checkout_override`·`centers.is_internal`) | 모두 존재 |
| 분리 SQL 미적용(`not_yet_applied`) | true — `centers.is_nicepay_review`·`accounts.nicepay_review_access` 없음 |
| 기간 RPC(`fetch_public_storefront_product_periods`) | 없음(P1 선택) |
| 현재 SELECT 정책(centers/classes/products) | 기대한 is_internal 규칙과 동일(허용 정책 1개씩, 제한 정책 없음) |
| 센터·상품 규모 | 센터 7(내부 4)·상품 62 — 분리 SQL 은 이 행을 바꾸지 않음 |
| 심사관 계정 | `pg_checkout_override=true` 1개(토스 심사 계정) — B안은 이 계정을 건드리지 않음 |
| 게이트 | 함수·트리거·테이블 존재, `mode=off`, 두 게이트 함수는 현재 토스용 플래그를 봄(P2b 대상) |
| **P0b** `verify_fix_refund_pg_origin_guard_20261017` | 7개 항목 **전부 true → PASS**(이력 없던 환불 패치가 운영 정의에 실제 적용돼 있음) |
| 신규 객체 이름 충돌(분리 SQL 이 만드는 함수 7·정책·트리거) | 없음 |
| 대상 컬럼(orders/memberships/cart_items/purchase_requests 의 center_id·product_id, reservations 의 class_id·membership_id) | 모두 존재 |
| P2b 치환 대상 | `orders_guard_nicepay_create` 1곳, `nicepay_claim_order` 2곳(코드+주석) → 스크립트 허용 범위(코드 ≥1, 총 ≤3) |
| sonjw222 계정 | 변경 없음: 매니저(1 활성 소속)·`is_member=false`·플랫폼 관리자 아님·`pg_checkout_override=false`·프로필 1 |
**판정: P0 PASS(일치 3/3), P0b PASS → P2 적용 BLOCKED 아님.** (해시가 하나라도 달랐다면 BLOCKED 로 유지했을 것.)

## 2. SQL 정의와 검증 대조 — 발견·수정(로컬만)
| 발견 | 내용 | 조치 |
|---|---|---|
| 컬럼 수 불일치 | P2 는 컬럼 **2개**(`centers.is_nicepay_review`, `accounts.nicepay_review_access`)를 추가하는데 검증은 centers 1개만 확인(`column_must_be_1`) | 검증을 `columns_must_be_2` 로 수정 |
| 트리거 수 오류 | 검증이 `tgname like '%nicepay_review%'` 로 세어 **운영의 기존 트리거 `nicepay_review_actions_append_only` 까지 포함**하고, B안 이후 정확한 수는 12(센터 플래그 1·accounts 1·INSERT 가드 5·UPDATE 가드 5) | 정확한 이름 패턴으로 `triggers_must_be_12` |
| 검증 범위 부족 | 신규 함수 7개 중 2개만, 목록 RPC 교체 여부·`center_rows_visible` 교체 여부 미확인 | 함수 7·RPC 3·center_rows_visible·PUBLIC 실행 불가 4개를 확인하도록 확장 |
| 심사관 수 | B안 이후에도 `pg_checkout_override` 로 셈 | `nicepay_reviewer_accounts` 와 `toss_override_accounts_unchanged` 로 분리 |
| 롤백 시나리오 시험 | 같은 오탐으로 운영과 같은 기반에서 실패할 수 있었음 | 정확한 이름으로 수정, 11/11 PASS |
**P2 가 만드는 것**: 컬럼 2, 함수 7(`nicepay_is_reviewer`, `nicepay_review_center_allowed`, `nicepay_review_center_member_allowed`, `nicepay_class_has_my_reservation`, `nicepay_review_guard_center`, `enforce_center_nicepay_review_admin_only`, `enforce_nicepay_review_access_admin_only`), 정책 4(제한 3 + 허용 1), 트리거 12.
**P2 가 바꾸는 기존 함수(운영 해시 일치 확인됨)**: `center_rows_visible`(조건을 AND 로 1개 추가), `fetch_public_storefront_products`·`fetch_purchasable_products`(각 1줄 추가: `and nicepay_review_center_member_allowed(...)`), (선택 P1 이 만든) `fetch_public_storefront_product_periods`(1줄). 그 외 기존 함수·정책은 교체하지 않는다(기존 허용 정책은 그대로, 제한 정책을 겹침).
**P2b 가 바꾸는 기존 함수**: `orders_guard_nicepay_create`·`nicepay_claim_order` — `pg_checkout_override` → `nicepay_review_access` 문자열 치환만.
**의존·순서**: P2 → P2b → (P3). P2b 는 P2 의 컬럼이 없으면 스스로 중단. 이미 적용된 NICEPAY 마이그레이션 6건과 객체가 겹치지 않는다(분리 SQL 은 게이트·provider_support 를 재정의하지 않음). 심사관 지정은 P2b 이후.
**롤백 시 심사 센터 공개**: 롤백 스크립트가 공개 가능한 심사 센터(승인·비내부)를 발견하면 아무것도 바꾸지 않고 중단(로컬 S1 PASS). 먼저 `update centers set is_internal = true where is_nicepay_review;`.

## 3. 정책 유지 확인(신규 로컬 DB, 운영과 같은 함수 정의 기반)
NICEPAY 심사관=`nicepay_review_access`, 토스 심사관=`pg_checkout_override`(NICEPAY 게이트 거부·기존 운영/토스 센터 접근 유지), 일반 회원은 심사 센터·NICEPAY 게이트 불가, 기존 센터·상품 행 변화 없음(행 수·해시), sonjw 형태 계정의 매니저 소속 유지(관리 화면 접근). 증거: `docs/qa/nicepay-preflight-20261029/permission-matrix-preflight.json`, `gate-matrix.json`. 일반 회원 온라인 결제는 비활성(직접결제만, 결제 버튼은 코드 상수가 차단).

## 4. NICEPAY 결제창 실행 준비 상태
| 항목 | 상태 |
|---|---|
| 운영 DB 기반(게이트·provider_support v8·환불 패치) | **준비됨**(운영 적용 확인, 게이트 off) |
| 서버 라우트·승인/취소 모듈·v3 prepare | **준비됨(코드, 통합 브랜치·미배포)** |
| v3 결제창 모듈(goPay) | **준비됨(코드, 로컬 단위 검증만)** |
| 전용 권한 분리 SQL(P2·P2b) | 작성·로컬 검증 완료, **운영 미적용** |
| NICEPAY 키 계열 확정·MID(`mwhabit01m`)/MerchantKey 또는 clientId/secret | **없음(발급 예정)** |
| Vercel 환경변수(`NICEPAY_*`, `NEXT_PUBLIC_PAYMENT_PROVIDER=nicepay` 등) | **미확인**(Vercel CLI·접근 없음. 키가 없으므로 미설정으로 간주) |
| 코드 상수 `NICEPAY_CHECKOUT_ACTIVATED=true` | **false**(코드 변경으로만 활성) |
| 통합 브랜치 병합·배포 | 미실시(승인 필요) |
| 게이트 mode `reviewer` 설정 | 미실시(현재 off) |
| 샌드박스/한글 상품명(EUC-KR)/WebView 필드/모바일 실기기 | 미검증(키 없음) |
| NICEPAY 의 심사 전용 센터·상품 허용 | 미확인(BLOCKED) |
