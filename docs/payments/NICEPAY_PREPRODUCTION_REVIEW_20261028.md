# NICEPAY 심사 전용 환경 — 운영 반영 전 최종 점검 (2026-10-28)

기준 커밋: `026175a`(주소·이용기간) → `ebab403`(센터 분리) → 이번 후속 커밋(결함 수정·검증 보강). 운영 DB 변경·SQL 실행·결제 활성화·Push·PR·병합·배포 없음. 기존 센터·상품 수정/삭제 없음.

## 1. 심사관 계정 `sonjw222@naver.com` — 운영 DB 읽기 전용 조회 결과
조회 방법(투명하게 밝힘): 이 PC 의 QA 환경 파일에 있는 운영용 service-role 키로 **GET 만** 수행(쓰기 0, 비밀번호·키·토큰 미출력). 이 키는 앞선 작업의 일반 QA 계정(anon+로그인)보다 넓은 권한이라, 필요한 항목만 조회했다.
| 항목 | 결과 |
|---|---|
| 계정 존재 | **있음** — 이전 Toss 심사 때 만든 "[토스 심사용] 모하빗 리뷰 계정"(생성 2026-09-13), 로그인 방식 email+apple, 확인됨·정지 아님, 마지막 로그인 2026-09-25 |
| 인증 사용자 ID | `8b91d1f7-8cb7-488f-a515-81b699357327` (accounts.id `dd6c752c-…`) |
| 권한 | `is_member=false`, `is_manager=true`, **플랫폼 관리자 아님**, 병합·비활성 없음 |
| `pg_checkout_override` | **false**(현재). 운영 전체에서 true 인 계정은 1개 — 별개의 "토스 심사 계정"(회원, 매니저 아님) |
| 센터와의 관계 | 매니저(active) 1곳: `[토스 심사용] 모하빗 리뷰 센터`(`f235a14d-…`, 승인·내부 센터). 센터 회원 0 |
| 기존 이력 | 프로필 1개, 수강권·주문·예약·포인트 **0건** |
| 해당 Toss 심사 센터 | 상품 1개 `모하빗 체험 수강권 10회` 200,000원·90일·공개판매, 수업 0, 주문 1, 매니저 1·회원 1 |
| 분리 SQL 적용 여부 | `centers.is_nicepay_review` 컬럼 없음 = **운영 미적용** 확인. `centers.is_internal` 은 있음 |
**이 계정에 플래그를 켜고 분리 SQL 을 적용했을 때의 영향(분석, 미실행):**
- 심사 센터(신규)가 보이고, 본인이 매니저인 Toss 심사 센터는 "매니저 예외"로 계속 보인다. 운영 센터(A10TION 등)는 회원 관점에서 보이지 않는다. 매니저 기능(자기 센터 관리)은 그대로.
- 이력이 0건이라 숨겨질 기존 구매·예약이 없다. 이 계정이 실제 운영자의 일상 계정이라는 증거는 없다(이름·생성 경위가 Toss 심사 전용). 운영 센터를 다른 경로로 쓰는지는 이 조회로 알 수 없다 → **사용자 확인 필요**.
- `is_member=false` 계정이 일반 구매 화면을 쓰는 데 지장이 있는지는 운영에서 검증하지 않았다(프로필 1개는 있어 주문 생성 전제는 충족).
- 플래그는 변경하지 않았다.

### 1-1. `pg_checkout_override` 재사용이 기존 Toss 심사 계정에 주는 영향
`토스 심사 계정`(회원, override=true, Toss 심사 센터의 회원, 주문 1건)은 분리 SQL 이 적용되는 순간 **같은 "심사관" 판정**을 받는다 → 운영 센터와 Toss 심사 센터가 보이지 않고 새 NICEPAY 심사 센터만 보인다(기존 이력 행은 보존되지만 센터 정보는 숨겨짐). 준비 브랜치가 병합되면 Toss 신규 결제는 어차피 비활성(`disabled`)이므로 Toss 심사 계정의 쓸모는 사라지지만, **분리 SQL 만 먼저 적용하면 Toss 쪽 접근이 바뀌는 부작용**이다.
| 대안 | 내용 | 장단점 |
|---|---|---|
| A. 재사용 + Toss 계정 정리 | Toss 심사 계정의 override 를 끄기로 결정한 뒤 적용 | 구조 단순. Toss 심사 계정 권한 변경 필요(정책 결정·승인) |
| B. **별도 권한 분리(권장 후보)** | `accounts.nicepay_review_access`(신규, 운영자만 변경) 를 추가하고 `nicepay_is_reviewer()` 가 이것을 본다. 카드 UI/DB 게이트(`pg_checkout_override`)는 그대로 둔다 → NICEPAY 심사관은 두 플래그, Toss 심사 계정은 불변 | 기존 계정 영향 0. 컬럼·보호 트리거·함수 1개 수정으로 작음. 단 심사관에게 플래그 2개 |
| C. Toss 심사 센터도 심사 센터로 지정 | 기존 Toss 센터를 `is_nicepay_review=true` 로 | Toss 심사 데이터를 NICEPAY 심사에 재활용. 센터 성격이 바뀌고 상품(200,000원)도 노출 → 비권장 |
정책 결정 전에는 운영 계정 권한을 바꾸지 않는다. B 로 정해지면 SQL 을 수정해 로컬에서 같은 매트릭스로 재검증한다.

## 2. NICEPAY 결제창 연동 검토 (`feat/nicepay-review-preparation-20261016`, 커밋 `6a847ee`)
| 질문 | 확인 결과 |
|---|---|
| 단건 MID 연동 상태 | **MID·키 미발급**(문서상 `mwhabit01m` 발급 예정). 코드는 두 키 계열을 지원: `rest_v1`(clientId/secretKey)은 결제창(JS SDK `AUTHNICE.requestPay`)까지 구현, **`v3_mid`(MID/MerchantKey)는 서버 승인·취소는 있으나 결제창(`nicepay-pgweb.js goPay`)은 "아직 준비 중"으로 명시적 거부** — `mwhabit01m` 형식은 MID 계열일 가능성이 높아 NICEPAY 가 어떤 계열 키를 주는지에 따라 **코드 작업이 추가로 필요**할 수 있다 |
| 운영/테스트 구분 | `NICEPAY_ENV=sandbox|production`(sandbox 는 `sandbox-api/sandbox-pay.nicepay.co.kr`, production 은 `api/pay.nicepay.co.kr`). SDK URL 은 허용 목록만 로드 |
| 결제창을 열기 위한 필수 설정 | ① 코드 상수 `NICEPAY_CHECKOUT_ACTIVATED=true`(코드 변경만) ② `NICEPAY_CHECKOUT_ENABLED=true` ③ `NICEPAY_API_FAMILY` ④ `NICEPAY_ENV` ⑤ `NICEPAY_RETURN_BASE_URL`(https) ⑥ 계열별 키(`NICEPAY_CLIENT_ID`+`NICEPAY_SECRET_KEY` 또는 `NICEPAY_MID`+`NICEPAY_MERCHANT_KEY`) ⑦ `PAYMENT_RETURN_TOKEN_SECRET`, `SUPABASE_SERVICE_ROLE_KEY` ⑧ 클라이언트 `NEXT_PUBLIC_PAYMENT_PROVIDER=nicepay`(빌드 시 고정 → 재배포) ⑨ DB 게이트 `nicepay_checkout_gate.mode`(off 기본) + 관련 SQL 적용. 하나라도 빠지면 503 fail-closed |
| 심사관만 접근 | **가능(5중 잠금)**: DB 게이트 모드 `reviewer`(주문 생성 트리거가 `pg_checkout_override` 계정의 주문만 허용), 서버 `nicepayGate`(주문 소유 계정의 override 확인), 클라이언트는 `NEXT_PUBLIC_PG_CHECKOUT_ENABLED` 가 켜지지 않은 한 일반 회원에게 PG 결제수단 비노출 |
| 일반 회원 비활성 유지 | **유지 가능**: `NEXT_PUBLIC_PG_CHECKOUT_ENABLED` 미설정 + 게이트 `reviewer`. 일반 회원이 직접 REST 로 `payment_provider='nicepay'` 주문을 만들어도 DB 트리거가 거부(준비 브랜치 SQL) |
| 승인 없이 결제창 호출까지 검증 | **원리상 가능**: `requestPay` 는 서버 `prepare` 가 준 파라미터로 SANDBOX 결제창을 열 뿐이고, 승인(과금)은 카드 인증 후 returnUrl 서버가 승인 API 를 부를 때만 일어난다 → 결제창이 열린 직후 닫으면 승인 없음. 단 **키가 없어 이번에는 호출하지 못했다 = BLOCKED**. 버튼 표시·prepare 응답·SDK 로드·창 열림은 서로 다른 단계로 따로 검증해야 한다 |
**Toss 와의 충돌 가능성(로컬 시험 병합, 폐기)**: 이 브랜치(`ebab403`)에 준비 브랜치를 병합해 보았다 — 충돌은 `docs/CHANGELOG.md`·`docs/TODO.md` 뿐(양쪽 유지), 타입체크·린트 통과, 단위 테스트 2770 통과 **1 실패**: 준비 브랜치의 `tests/unit/productsPurchaseGuide.test.ts`("PG사명 단정·사업장 주소·결제창 흉내가 없다")가 `/products` 푸터의 `BUSINESS_INFO.address` 를 금지 — **주소 공개 승인과 함께 이 테스트를 갱신해야 병합 가능**. 준비 브랜치는 Toss/PortOne 을 신규 결제에서 제거(`resolveProviderName` toss→`disabled`)하므로 병합 즉시 main 의 Toss 결제 경로가 닫히고(과거 Toss 거래의 환불·조회는 서버 라우트가 계속 처리), 심사관의 카드 경로는 NICEPAY 로 바뀐다. Toss 로 진행 중인 심사가 있다면 병합 전에 확인.

## 3. SQL 통합 점검
**충돌 없음**: 이번 분리 SQL 이 만들거나 바꾸는 객체(`center_rows_visible`, 목록 RPC 3개, centers/classes/products 정책, `nicepay_*_guard` 트리거, 새 컬럼)와 준비 브랜치 SQL 이 만드는 객체(`nicepay_checkout_gate*`, `orders_guard_nicepay_create`, `orders_guard_pg_state`, `create_order_secure`, `_refund_membership_core` 패치 등) 사이에 같은 이름·같은 함수 정의가 없다. orders 의 BEFORE INSERT 트리거는 서로 다른 이름으로 공존한다(이름순 실행, 각자 독립 검사). 두 SQL 모두 `accounts.pg_checkout_override` 를 심사관 기준으로 쓴다.
**⚠ 문서 불일치 발견**: 준비 브랜치 `NICEPAY_CONTRACT_HANDOFF_20261017.md` §5 의 순서(preflight→role_guard→provider_support→create_order_secure)는 **주문 생성 게이트와 환불 패치를 빠뜨렸다** — 각 SQL 헤더의 선행 조건대로 하면 아래 순서여야 한다(그 순서대로 하지 않으면 스크립트가 스스로 중단).
**전체 실행 순서(실행하지 않음)** — 상세·전문은 `docs/payments/NICEPAY_SQL_RUNBOOK_20261028.md`
| 단계 | 파일 | 효과 | 상태 |
|---|---|---|---|
| P0 | `preflight_nicepay_review_center_isolation_20261028.sql`(읽기 전용) | 운영 함수 정의 해시가 기대값과 같은지 | 이번 |
| P1 | (선택) `add_public_storefront_product_periods_20261027.sql` | 공개 기간 RPC | `026175a` |
| P2 | `add_nicepay_review_center_isolation_20261028.sql` → `verify_…` | 센터 분리 | 이번 |
| P3(별도 승인·데이터) | `seed_nicepay_review_center_20261028.sql`, 심사관 지정 UPDATE | 심사 센터·상품, 심사관 플래그 | 이번 |
| 이후(NICEPAY 활성화 시, 준비 브랜치) | `preflight_nicepay_patch_targets_20261016` → `fix_orders_insert_role_guard_20261017` → `fix_refund_pg_origin_guard_20261017` → `fix_refund_server_path_fail_closed_20261017` → `fix_refund_amount_integrity_20261017` → `add_nicepay_checkout_gate_20261017` → `add_nicepay_provider_support_20261016` → `fix_create_order_secure_allow_nicepay_20261016` → `fix_nicepay_claim_gate_20261017` (+각 `verify_*`) | NICEPAY 결제 DB 기반 | 준비 브랜치(미실행) |
**기존 센터·상품에 미치는 영향**: 분리 SQL 은 기존 행을 바꾸지 않는다(적용 전후 행 수·해시 동일, 로컬). 일반 회원·비회원·운영 센터 매니저의 가시성은 불변. 심사관 플래그를 가진 계정만 운영 센터가 숨겨진다.
**롤백 시 심사 센터 일반 공개 가능성**: 있다 — 분리 정책이 사라지면 승인·비내부 심사 센터가 모두에게 보인다(로컬 재현: 롤백 후 승인 상태면 비회원도 센터 1·상품 3·수업 1 조회). **보완**: 롤백 스크립트가 공개 가능 상태를 발견하면 아무것도 바꾸지 않고 중단. 센터 하나를 닫으면(`is_internal=true` 또는 승인 상태 해제) 상품·수업 직접 조회까지 같이 막힘을 로컬에서 확인(비회원·일반·심사관 모두 0행). 참고: `centers.status` 는 `guard_center_status_change` 트리거 때문에 SQL Editor(postgres)로는 못 바꾸고 플랫폼 관리자만 가능 → 롤백 선행 조치는 `is_internal=true` 를 안내.
기간 RPC 복원: 분리 SQL 이 만든 것이면(함수 주석 표식) 롤백 시 삭제, 이전부터 있었으면 `026175a` 정의로 복원(로컬 4개 시나리오 통과).

## 4. 심사 상품 구성 검토
전제: NICEPAY 가 심사 전용 상품을 허용한다(서면 확인 필요). 허위 센터·허위 수업을 정상 상품처럼 보이게 하지 않는다.
**실제 제공 가능성 체크리스트(사용자 확인)**: ① 심사 센터가 실제로 수강권을 받아 이용 처리할 수 있는지(수업 1개 이상 개설 또는 센터 관리자가 수동 이용 처리), ② 상품 설명이 실제 서비스와 일치, ③ 환불은 기존 환불정책 페이지 기준 그대로, ④ 가격은 실제 청구 가능한 금액이며 NICEPAY 가 허용하는 최소 금액·테스트 방식을 확인.
**제안(가격·내용 미확정 — 값은 사용자 결정)**
| 상품 | 만료 방식 | 이용 시작 | 사전예약기간 | 서비스 제공기간(결제일 2026-10-30 예시) | 판정 |
|---|---|---|---|---|---|
| 1회 수업 이용권 | `days` 7일 | 결제일 | 0일 | 10/30 ~ 11/06 | ≤60일·≤1년 충족 |
| 4주 수업 이용권 | `days` 28일 | 결제일 | 0일 | 10/30 ~ 11/27 | 충족 |
| 3개월 수업 이용권 | `days` 90일 | 결제일 | 0일 | 10/30 ~ 2027/01/28 | 충족 |
- `days` 방식을 쓰는 이유: 결제할 때마다 새 기간이 생겨 고정 만료일 상품처럼 "판매 중인데 이미 만료"(운영의 원데이안무반 사례)가 생기지 않는다. `none`(만료일 없음)은 1년 이내를 증명할 수 없어 쓰지 않는다. `rolling_month` 는 사전예약이 최대 약 31일이라 기준은 충족하지만 심사 설명이 복잡해 비권장.
- 서버 계산과 화면 표시 일치는 단위 테스트(PGlite 전수 대조)로 이미 검증돼 있다. 시드의 기간 값은 계약 테스트로 고정(7/28/90일).
- NICEPAY 담당자 확인: 최소/최대 결제 금액, 심사용 카드·테스트 승인 방식, 심사 후 취소·환불 처리 방식, 심사 상품 허용 서면 확인, 정기결제(`mwhabit02m`, 센터 구독료)는 이 센터와 별개인지.

## 5. 이번 점검에서 직접 재현한 결함과 수정
| # | 결함(재현) | 수정 | 검증 |
|---|---|---|---|
| 1 | **상품 id 와 센터 id 를 어긋나게 넣은 직접 REST 주문이 통과** — 일반 회원이 `center_id=운영센터, product_id=심사 상품`, 심사관이 `center_id=심사센터, product_id=운영 상품`으로 `orders` INSERT 성공(`orders` INSERT 정책은 `profile_id` 와 구매 자격만 보고 center_id 일치를 보지 않았고, 내 트리거는 행의 center_id 만 검사) | 트리거가 행의 center_id + 상품의 **실제 센터** + 수업 센터 + 수강권 센터를 모두 검사 | 수정 전 INSERTED ×2 → 수정 후 DENY (`evidence/mismatched-center-repro-BEFORE/AFTER-fix.txt`) |
| 2 | 같은 우회가 **장바구니(cart_items)·구매신청(purchase_requests)** 에도 존재(회원이 직접 INSERT 가능, 정직한 심사 center_id 도 통과) | 두 테이블에도 같은 트리거 | INSERTED ×3 → DENY |
| 3 | UPDATE 경로: 센터/상품/수업/수강권 컬럼을 나중에 바꿔치기 | 해당 컬럼이 실제로 바뀔 때만 검사하는 UPDATE 트리거(orders·memberships·cart_items·purchase_requests·reservations). 정상 갱신(센터·상품 불변)은 통과 확인 | 직접 시험 + 기존 보호(주문 취소 UPDATE 의 상품 변경 거부, 예약 `class_id` 변경은 컬럼 권한 부족)도 확인 |
| 4 | 롤백이 공개 가능 상태를 막지 않음 / 기간 RPC 복원이 이전 상태를 구분하지 못함 | 롤백 preflight 중단 + 기간 RPC 표식 | `rollbackScenarios.mjs` 11/11 |
| 5 | 검증 스크립트가 대상 확인 없이 접속 | `assertIsolated.mjs`(기존 `isolatedTargetGuard` 재사용)를 모든 스크립트 첫 줄에서 호출 | 잘못된 환경 파일 7종 × 스크립트 6개 → 종료 코드 ≠ 0, **네트워크 시도 0건**(preload 카운터, 정상 환경은 10건으로 카운터 유효 확인) |
| 6 | 심사관이 되면 **기존 운영 센터 예약이 내 예약 화면에서 사라져 UI 로 취소 불가** | 내 예약이 걸린 수업만 읽는 예외 정책(수업만, 센터·상품 예외 없음) | 심사관 화면에 기존 예약 표시 + 취소 가능, 새 예약은 계속 차단 |
**기존 이력 사후 처리(브라우저, 심사관 B)**: 구매 내역 화면에서 운영 센터 대기 주문 **주문 취소 성공**, 사용 이력 없는 수강권 **환불 성공(refunded)**, 사용한 수강권 환불은 기존 업무 규칙("이미 사용한 수강권은 센터에 문의")으로 거절(우리 가드와 무관), 예약은 화면 표시·RPC 취소 가능. 새 예약/주문(센터 불일치 포함)만 차단.
**카테고리 화면**: 심사관 = 심사 센터만, 일반·비회원 = 운영 센터만(390/1440 × 라이트/다크 28건 불일치 0, `history-category/`).

## 6. 검증하지 못한 범위
- 운영 DB 의 함수·정책 현재 정의(분리 SQL 이 3개 함수를 통째로 다시 만든다) — P0 preflight 로 사용자가 확인해야 함. 기대값은 공유 DEV 와 같은 계보의 정의에서 측정.
- NICEPAY 결제창 실제 호출·승인 취소(키 없음), v3_mid 결제창(미구현), Toss 진행 중 심사 여부.
- `is_member=false` 운영 계정의 구매 화면 동작, 이 계정을 다른 용도로 쓰는지.
- 실기기(iOS/Android)·WebView, Safari/Firefox.
- 분리 정책의 대규모 데이터 성능(행마다 판정 함수 호출) — 로컬 소량 데이터만.
- 심사관의 다른 센터 기능(공지·커뮤니티·문의 등 center_members 기반 테이블)은 센터 숨김과 `center_rows_visible` 적용 범위만 확인.

## 7. 정책 결정 필요
1. 심사관 플래그 방식: A(재사용+Toss 계정 정리) / **B(별도 권한 컬럼)** / C. 2. Toss 심사 계정(override=true)의 처리. 3. `sonjw222@naver.com` 을 NICEPAY 심사 전용으로 쓸지(운영 계정과 분리), 운영 센터를 쓰는지 여부. 4. 심사 상품 가격·내용·수업 개설. 5. 심사 종료 후 처리(플래그 해제·센터 비공개). 6. 준비 브랜치 병합 시점과 `/products` 주소 테스트 갱신(주소 공개 승인과 함께). 7. NICEPAY 키 계열(rest_v1 / v3_mid) — v3 면 결제창 구현 추가.
