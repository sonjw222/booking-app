# NICEPAY 심사관에게 실제 센터(A10TION 피겨팀) 상품 보여 주기 — 접근 제어 변경 (2026-11-03)

로컬 브랜치 `feat/nicepay-real-products-review-20261103`(`origin/main` `368aa3e` 기준). **운영 SQL·운영 데이터·결제 설정은 건드리지 않았다.** 운영 적용은 사용자 승인 후 별도.

## 1. 현행 구조 — 어디서 A10TION 이 차단되나
| 단계 | 파일·객체 | 심사관(`accounts.nicepay_review_access`)에게 |
|---|---|---|
| 홈·센터 검색·종목별 목록·문의 센터 검색 | **클라이언트** `lib/home.ts`(6곳)·`lib/inquiries.ts` + `lib/nicepayReviewScope.ts` 가 `is_nicepay_review=true` 를 쿼리에 추가 | 심사 센터만 보임 |
| 센터·상품·수업 직접 조회 | **DB RLS** restrictive 정책 `nicepay_review_isolation`(centers/classes/products) → `nicepay_review_center_allowed()` | 운영 센터 숨김 |
| 공개 수강권 목록 `/products` | RPC `fetch_public_storefront_products`(+기간 `…_product_periods`) → `nicepay_review_center_member_allowed()` | 심사 센터만 |
| 구매 가능 상품 | RPC `fetch_purchasable_products` → `nicepay_review_center_member_allowed()` | 심사 센터만 |
| 주문·장바구니·구매신청·예약·수강권 발급 | **DB 트리거** `nicepay_review_guard_center()`(orders·cart_items·purchase_requests·memberships·reservations) → `member_allowed()` | 심사 센터만 |
| 카드 결제(게이트) | `nicepay_order_is_review_target()` / `orders_guard_nicepay_create` / `nicepay_claim_order`(P2b) | `is_nicepay_review` 센터 주문만 |
클라이언트 필터와 DB 판정이 모두 있으므로 한쪽만 바꾸면 동작하지 않는다. `is_nicepay_review` 조건을 통째로 지우지 않고, **심사관 계정 ↔ 센터를 명시적으로 잇는 허용 목록**을 새로 두었다.

## 2. 설계 (최소 권한)
- 새 테이블 `nicepay_review_center_grants(account_id, center_id, can_purchase default false, note)` — RLS 켜고 정책 0개(클라이언트 읽기·쓰기 불가), SQL Editor/서버만 기록. 센터 UUID 는 이 테이블(중앙)에만 있고 코드에는 없다.
- **조회 허용(기본, can_purchase=false)**: 심사관이 그 센터의 센터·상품·수업·공개 RPC·가격·이용기간을 본다. 주문·장바구니·구매신청·예약은 센터 가드가 거부한다.
- **구매 허용(can_purchase=true)**: 주문·장바구니·구매신청·예약 경로가 열린다. **카드 결제 게이트는 그대로** 심사 센터만 → 허용 센터의 NICEPAY 카드 결제는 어떤 경우에도 열리지 않는다(결제 활성화 아님).
- 허용 대상은 승인된 운영 센터(내부·심사 센터 제외), 계정은 심사관 권한 보유자만(트리거). 심사관 권한을 끄면 허용 행은 즉시 무효.
- 바뀌는 함수 4개만: `nicepay_review_center_allowed`·`member_allowed`·`nicepay_review_guard_center`(교체), `nicepay_review_center_purchase_allowed`·`…granted`·`…purchase_granted`·`nicepay_my_review_center_ids`(신규). **목록 RPC·`create_order_secure`·주문 정책은 다시 만들지 않으므로** 만료 상품 숨김 SQL(`fix_expired_fixed_date_products_20261031.sql`)과 적용 순서가 무관하다.
- 앱: `nicepayDiscoveryScope()` 가 RPC 로 허용 센터 id 를 읽어 탐색 쿼리를 `(심사 센터 OR id ∈ 허용 센터)` 로 좁힌다. RPC 가 아직 없으면(SQL 적용 전) 빈 목록 → 기존 동작. **코드를 먼저 배포해도 안전**하다.
- 홈 심사관 섹션 문구만 "심사 전용 센터/심사용 수강권…" → "심사 안내 센터/수강권 및 결제 과정 확인"(실제 센터가 섞이므로).

## 2-b. 2차 보완(2026-11-03, SQL 검토 반영)
- **preflight 강화**: 교체 대상 함수 3개의 `pg_get_functiondef` **MD5 전체 비교** — 적용 전(운영 읽기 전용 조회 값 `636cb33f…`/`a3a299f7…`/`0e8dc90f…`, 로컬 P2 적용 DB 측정값과 동일 확인) 또는 이 파일 적용본(`078ffece…`/`030f304b…`/`7b5c7ca9…`, 멱등 재실행)과 다르면 아무것도 바꾸지 않고 중단. 문자열 포함 검사 제거.
- **센터 상태 변화 시 즉시 무효**: 허용 판정(`nicepay_review_center_granted`/`…purchase_granted`/`nicepay_my_review_center_ids`)이 판정 시점에 센터가 `approved`·비내부·비심사 센터인지 다시 확인. 승인 취소·내부 전환 → 조회·구매 허용 즉시 사라지고, 되돌리면 허용 행이 그대로 되살아남. 일반 회원·매니저·관리자 가시성은 변하지 않음(테스트로 확인).
- **조회 전용 UI**: `lib/nicepayReviewScope.ts` `fetchNicepayViewOnlyCenter()` → 센터 화면(`app/center/[id]/page.tsx`)은 시트 제목 "수강권 · 상품 안내"+안내 문구, 담기·구매·장바구니·예약 버튼과 "구매하거나 담을 수 있어요" 문구 숨김("수강권 안내 보기"), 결제 화면(`app/checkout/page.tsx`)은 직접 URL 로 들어와도 안내 + 버튼 비활성("조회 전용 — 구매할 수 없어요"). 이용기간·가격은 그대로. 구매 허용(`can_purchase=true`)·일반 회원은 기존 화면. 서버는 UI 와 무관하게 거부(UI 는 안내용).
- **조회 전용 유지 검증**: INSERT 뿐 아니라 기존 주문·장바구니의 상품/센터 UPDATE 거부(값 불변), reserve_class·reserve_with_membership RPC 거부, 서버(service_role) 경로 불변, 사전에 있던 주문·예약의 본인 상태 변경(취소)은 센터 가드가 막지 않음(사후 처리 보존).
- **롤백 수정**: 롤백 SQL 이 P2 파일의 목록 RPC 정의까지 잘못 포함해 만료 상품 숨김을 되돌릴 뻔한 결함을 생애주기 시험으로 발견·수정 — 지금은 **정확히 함수 3개만** 복원하고(정적 시험으로 고정), 복원 후 MD5 가 운영 적용 전 값과 같음을 로컬에서 확인, 재실행 가능(멱등), 허용 행이 있으면 중단.
- 생애주기 시험 `realCenterGrantsLifecycle.mjs` 30건: 적용 → 허용 등록 → 권한 철회(행 삭제·심사관 권한 회수) → 롤백(행 있으면 중단) → 재적용 → 정의 변조 감지. 매 단계 역할 7 × 센터 4 가시성 스냅샷이 적용 전과 동일(허용 센터 한 칸 제외), 목록 RPC·주문 생성 함수 정의 MD5 불변.

## 3. 검증(로컬 격리 Supabase, 모의 — 운영·결제 호출 0)
- `scripts/isolated/nicepayReview/realCenterGrants.mjs` **57/57 PASS**(조회 전용 UPDATE·RPC·센터 상태 변화 포함): 허용 전 동일 동작, 조회 허용(센터·11월 상품 3종·가격·기간 DB 일치·만료 10월 상품 제외·다른 운영 센터 숨김·기존 심사 센터 유지), 조회 허용에서 주문·장바구니·구매신청·`create_order_secure` 거부, 구매 허용에서 직접결제 주문 가능·**만료 상품 신규 주문 거부**·**NICEPAY 카드 주문은 거부**(기존 심사 센터는 가능), 일반 회원/토스 심사관/매니저/관리자/심사관 겸 매니저 규칙 불변, 허용 삭제·권한 회수·잘못된 대상 지정 거부, 허용 목록 테이블 접근 거부, 시험 전후 운영성 데이터 지문 동일.
- 브라우저(Playwright) 6건(조회 전용 UI·구매 허용 UI·일반 회원 불변 포함): 허용 전/후 홈·`/products`·센터 상세(80,000원·320,000원·횟수 선택)·조회 허용에서 구매 시도 시 "주문 생성에 실패했어요: 이 센터의 상품·수업은 이용할 수 없어요" 표시·주문 0·일반 회원 화면 불변·해제 후 숨김.
- 기존 회귀: 격리 스크립트 `gateReviewerTarget` 28/28, `idMismatch` 19/19, `permissionMatrix`·`gateMatrix`·`reservationGuard` 정상, 기존 NICEPAY 브라우저 QA 23 PASS, Vitest 2936(+신규 SQL 정적 9·스코프 6), SQL 테스트 335, lint 신규 0, build 통과. 롤백(행 있으면 중단·없으면 복원)·재적용(멱등) 확인.
- **검증하지 못한 것**: 운영 DB 의 실제 A10TION 상품 상태(운영 접근 없음) — 읽기 전용 점검 SQL `audit_nicepay_real_center_products_readonly_20261103.sql` 를 사용자가 실행해야 한다(수업 연결·수업 일정·수량·만료 규칙·판매 이력). 실제 NICEPAY 외부 인증·승인, 실기기.

## 4. 운영 적용 절차(승인 후, 사용자 실행)
1. (읽기) `audit_nicepay_real_center_products_readonly_20261103.sql` — 센터 이름이 `A10TION 피겨팀` 인지, 3개 상품의 판매·만료·수업 연결 확인.
2. (전제 확인) P2 적용됨, 그리고 만료 상품 숨김 SQL(`fix_expired_fixed_date_products_20261031.sql`) 적용 여부 — 이번 요구의 "만료된 10월 상품이 목록·신규 주문에서 제외"는 이 SQL 이 적용돼 있어야 성립한다.
3. `add_nicepay_review_real_center_grants_20261103.sql` 실행 → `verify_add_nicepay_review_real_center_grants_20261103.sql`(전부 true, 행 0).
4. 앱(이 브랜치) 배포 — 순서 무관(SQL 전 배포도 안전).
5. 허용 행 추가(조회만, 기본): 
   ```sql
   insert into nicepay_review_center_grants (account_id, center_id, can_purchase, note)
   select a.id, '8965e09c-0d2b-44c6-ab26-40a85507f8b5', false, 'NICEPAY 카드사 심사: 실제 수강권 조회 (조회만)'
   from accounts a join auth.users u on u.id = a.auth_id
   where u.email = '<NICEPAY 심사관 계정 이메일>' and a.nicepay_review_access;
   ```
   (대상 이메일이 틀리면 0행 — 삽입 후 `select count(*) from nicepay_review_center_grants` 로 1 확인.)
6. 심사 종료 후 해제(계정·센터를 지정, 전체 삭제 금지): `delete from nicepay_review_center_grants where account_id = '<심사관 account id>' and center_id = '8965e09c-0d2b-44c6-ab26-40a85507f8b5';`

## 5. 롤백
`rollback_add_nicepay_review_real_center_grants_20261103.sql` — **한 트랜잭션, 하나라도 어긋나면 아무것도 바뀌지 않는다.**
1. 시작 시 복원할 함수 3개의 현재 정의 MD5 가 (이 파일 적용본) 또는 (이미 복원된 적용 전 원본)과 같아야 한다 — 운영에서 따로 바뀌었으면 변경 없이 중단.
2. 허용 행이 있으면 중단한다(메시지에 계정/센터 목록 표시). **전체 삭제(`delete … ;`)는 권장하지 않는다.** 아래처럼 계정·센터를 지정해 한 행씩 해제한 뒤 다시 실행한다.
   ```sql
   -- 현재 허용 행 확인
   select g.account_id, g.center_id, c.name as center_name, g.can_purchase from nicepay_review_center_grants g join centers c on c.id = g.center_id;
   -- 특정 계정·센터만 해제(한 행씩)
   delete from nicepay_review_center_grants where account_id = '<심사관 account id>' and center_id = '<센터 UUID>';
   ```
3. 함수 3개를 P2 정의로 복원하고 새 객체를 삭제한다.
4. 복원 직후 3개 함수의 MD5 가 적용 전 운영 정의와 다르면 **EXCEPTION → 트랜잭션 전체 취소**(복원·삭제가 모두 되돌아가 롤백 이전 상태 유지).
순서: 이 롤백 → (필요 시) P2 롤백. 재실행 가능(이미 복원된 원본 해시 허용). 센터·상품·주문 데이터는 건드리지 않는다.

## 6. 기존 심사용 상품 처리 권고(이번에는 변경 없음)
`[심사 전용] 모하빗 스튜디오…`의 "1회/5회/10회 이용권 (심사용)" 15,000/60,000/110,000원은 NICEPAY 가 지적한 "실제 판매와 다른 상품"이다. 권고: ① A10TION 허용 확인과 NICEPAY 회신 후, ② 심사관 허용 센터를 A10TION 만으로 두고 ③ 심사 센터는 **삭제하지 않고** 먼저 `close_nicepay_review_20261029.sql`(권한 해제·게이트 off·비공개)로 닫는 순서가 안전하다(이 SQL 은 데이터 삭제 없음). 이후 필요하면 `is_on_sale=false` 로 판매 중지. 위 절차 전에는 유지(카드 결제 시험 경로가 이 센터에만 열려 있다).

## 7. 알아 둘 것 / 사용자 결정
- **카드 결제는 A10TION 에서 불가**(게이트). "조회 가능"과 "결제 가능"은 다르다. 실제 상품으로 카드 결제 시험을 하려면 게이트(`nicepay_order_is_review_target`)·승인 흐름 변경과 **실제 센터의 실거래(정산·회원 수강권 발급)** 가 생기므로 별도 설계·승인이 필요하다.
- A10TION 11월 상품은 **11월 28일 만료** → 그 이후 목록에서 자동으로 사라진다(심사가 그 이후까지 이어지면 보여 줄 상품이 없다).
- 조회 전용 허용에서 구매를 누르면 거부 메시지가 그대로 노출된다(기능상 정상, 문구 개선은 후속).
- 구매 허용(`can_purchase=true`)은 직접결제 "주문 접수"까지 열려 실제 센터에 대기 주문이 생길 수 있다 → 기본값 false 유지 권장.
