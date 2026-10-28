# NICEPAY 심사 전용 센터·수강권 분리 (2026-10-28)

브랜치 `feat/nicepay-review-center-20261028`. 선행 커밋 `026175a`(사업장 주소·서비스 제공기간 표시·공개 기간 RPC SQL 초안)는 그대로 보존했고, 이번 변경은 그 위의 **별도 커밋**이다. 구현·검증은 **로컬 일회용 Supabase(운영·공유 DEV 아님)** 에서만 했다. 운영/공유 DEV SQL 적용·결제 활성화·Push·병합·배포 없음. #244 승인은 재사용하지 않았다.

## 1. 접근 기준(목표)
| 대상 | 일반(운영) 센터·상품 | 심사 센터(`centers.is_nicepay_review`)·상품 | 근거/비고 |
|---|---|---|---|
| 비회원 | 조회 가능(기존 그대로) | **불가**(목록·직접 URL·공개 RPC) | |
| 일반 회원 | 조회·구매·예약 가능(기존 그대로) | **불가**(조회·구매 주문·예약·수강권 발급 트리거 차단) | 기존 수강권·예약·주문 이력은 그대로 |
| 심사관(`accounts.pg_checkout_override=true`) | **불가**(심사관이 매니저/플랫폼 관리자인 센터는 예외) | 조회·구매 화면·결제 화면 접근 가능 | 이메일이 아니라 인증된 계정 기준 |
| 센터 매니저 | 자기 센터 관리(기존 그대로) | 해당 심사 센터의 매니저만 관리 가능, 다른 센터 매니저는 불가 | |
| 플랫폼 관리자 | 전체 | 전체 | 관리 기능 유지 |
- **`is_internal`(QA/내부 센터)과의 관계**: 대체하지 않고 **그대로 둔 채 AND 로 겹친다**. `is_internal`은 "그 센터 회원/관리자만", `is_nicepay_review`는 "심사관만(+매니저/관리자)". 심사 센터를 `is_internal`로 만들지 않는다(그러면 심사관이 회원 등록 없이는 못 본다).
- **심사관 권한과의 관계**: 기존 `pg_checkout_override`(관리자만 변경 가능, 트리거 보호)를 그대로 재사용한다. 새 권한/계정/컬럼을 만들지 않는다. **결과적으로 이 플래그가 켜진 계정은 운영 센터가 보이지 않게 된다**(되돌리려면 플래그를 끈다).
- **심사 센터 지정**: `centers.is_nicepay_review`는 플랫폼 관리자/SQL Editor만 변경 가능(트리거). 매니저·일반 회원의 지정/변경 시도 거부를 확인.

## 2. 구현
**SQL — 적용 순서**
1. (선행, 선택) `add_public_storefront_product_periods_20261027.sql` — 커밋 `026175a`. 비회원 공개 목록 상품별 이용기간 RPC. 2번이 같은 함수를 조건 추가 버전으로 다시 만들므로 1번 없이도 안전.
2. `add_nicepay_review_center_isolation_20261028.sql` — 이번 변경. preflight → 컬럼 → 트리거(플래그 보호) → 판정 함수 → `center_rows_visible` 교체 → restrictive 정책 3개 → 구매/예약/수강권 트리거 3개 → 목록 RPC 3개 교체. 단일 트랜잭션.
3. `verify_add_nicepay_review_center_isolation_20261028.sql` — 읽기 전용.
4. (별도 승인, 데이터 생성) `seed_nicepay_review_center_20261028.sql` — 분리 SQL 미적용이면 중단하는 가드 포함.
5. 심사관 지정: `update accounts set pg_checkout_override = true where auth_id = (select id from auth.users where email = '<심사관 이메일>');` — SQL Editor 로만(별도 승인).
- 롤백: `rollback_add_nicepay_review_center_isolation_20261028.sql`(정의 복원·정책/트리거/함수 삭제, 컬럼·데이터 보존). **공개 가능한 심사 센터(승인·비내부)가 있으면 롤백이 아무것도 바꾸지 않고 중단한다.** 먼저 `update centers set is_internal = true where is_nicepay_review;`(또는 플랫폼 관리자가 승인 상태 변경 — `status` 는 SQL Editor 의 postgres 로 변경 불가) 후 실행. 기간 RPC 는 분리 SQL 이 만든 것이면 삭제, 이전부터 있었으면 이전 정의로 복원.

**차단 지점(화면 숨김이 아니라 서버)**: ① centers/classes/products SELECT restrictive 정책(수업만 예외: 내 예약이 걸린 수업은 읽기 허용 — 기존 예약 사후 처리 보존), ② `center_rows_visible`(휴무일·리뷰·룸·설정 등 9개 테이블 정책 + class/product_rows_visible 이 따라옴), ③ 공개/회원 상품 목록 RPC + 기간 RPC, ④ orders/memberships/cart_items/purchase_requests/reservations 의 INSERT 및 센터·상품·수업·수강권 컬럼 변경 UPDATE 트리거 — **클라이언트가 보낸 center_id 만 믿지 않고 상품의 실제 센터·수업의 센터·수강권의 센터 모두를 검사**(SECURITY DEFINER RPC 우회 방지; 서버/service_role 은 통과). 앱 코드 변경 없음. (2026-10-28 후속 점검에서 center_id/상품 불일치 직접 REST 주문 결함을 재현해 수정 — `NICEPAY_PREPRODUCTION_REVIEW_20261028.md` §5)

## 3. 로컬 검증 결과(격리 Postgres, 실제 로그인)
권한 매트릭스 `docs/qa/nicepay-review-center-20261028/evidence/permission-matrix-{before,after}-isolation.json`(적용 전에는 전원에게 심사 센터가 노출됨 = 분리 필요성 입증).
| 페르소나 | 센터 목록 | 심사 센터 직접 | 운영 센터 직접 | 공개 RPC | 심사 상품 주문 | 운영 상품 주문 | 심사 수업 예약 | 운영 수업 예약 |
|---|---|---|---|---|---|---|---|---|
| 비회원 | 운영만 | 불가(0행) | 가능 | 운영만 | - | - | - | - |
| 일반 회원 | 운영만 | 불가 | 가능 | 운영만 | **거부** | 성공 | **거부** | 성공 |
| 심사관 | 심사만 | 가능 | **불가** | 심사만 | 성공 | **거부** | 성공 | **거부** |
| 운영 센터 매니저 | 운영만 | 불가 | 가능 | 운영만 | 거부 | 성공 | - | - |
| 심사 센터 매니저 | 심사+운영 | 가능 | 가능(일반 계정이므로) | 둘 다 | 성공 | 성공 | - | - |
| 플랫폼 관리자 | 전체 | 가능 | 가능 | 둘 다 | - | - | - | - |
- 기존 데이터 보존: 적용 전후 운영 센터 2·상품 11·주문 8·수강권 2·예약 2·수업 1 의 행 수와 내용 해시가 동일(`evidence/existing-data-snapshot-...txt`). 심사관·일반 회원의 기존 수강권/주문/예약 이력은 그대로 조회됨.
- 적용→롤백→재적용→재적용(멱등) 모두 오류 없음. 매니저의 심사 센터 생성·회원의 스스로 심사관 지정 거부 확인, 매니저의 플래그 변경은 트리거가 거부(RLS 우회 경로로 확인).
- 브라우저(390/1440 × 라이트/다크, 비회원/일반/심사관, 검색·홈·카테고리·내 예약·구매 내역·직접 URL·구매 시트·결제 화면): `qa-results.json`. 검색은 심사관=심사 센터만, 일반/비회원=운영 센터만. 페이지 오류 0, 수평 스크롤 0.
- 결제 비활성 유지: 일반 회원 결제 화면은 "직접결제"만. 심사관만 카드 등 노출(기존 구조). 결제 버튼은 누르지 않음.

## 4. 심사 센터·상품 설계(제안 — 값은 사용자 확정 필요)
센터 `[심사 전용] MWHABIT NICEPAY 카드사 심사 환경`(주소·사업자번호 없음, 심사 환경임을 소개문에 명시). 상품 3종은 모두 **이용 시작일=결제일(사전예약 0일)**, 서비스 종료일=결제일+N일:
| 상품 | 가격(placeholder) | 서비스 내용 | 서비스 제공기간 | NICEPAY 기준 |
|---|---|---|---|---|
| [심사용] 1회 수업 이용권 | 1,000원 | 1회 수업 이용 | 결제일~+7일 | 충족 |
| [심사용] 4주 수업 이용권 | 4,000원 | 4주(28일) 기간제 | 결제일~+28일 | 충족 |
| [심사용] 3개월 수업 이용권 | 10,000원 | 3개월(90일) 기간제 | 결제일~+90일 | 충족 |
취소·환불은 새 기준을 만들지 않고 기존 환불정책 페이지를 따른다고만 표기. **실제 제공 가능한 서비스 또는 NICEPAY 가 승인한 심사용 거래만 허용** — 가격·수업 실체는 사용자 확정 전 운영에 만들지 않는다.

## 5. NICEPAY 결제창 접근 — BLOCKED
- main: 심사관은 결제 화면에서 카드 등 결제수단을 볼 수 있으나 그 경로는 **Toss/Mock** 이며 NICEPAY 가 아니다(로컬에서는 "테스트 결제(Mock)" 안내). 결제 버튼은 누르지 않았다.
- NICEPAY 준비 브랜치(`feat/nicepay-review-preparation-20261016`): 코드 상수 `NICEPAY_CHECKOUT_ACTIVATED = false`(코드 변경으로만 활성), 서버 승인 라우트·DB 게이트 SQL(`add_nicepay_checkout_gate_20261017.sql` 등)은 미적용·MID/키 미발급 → 결제창 호출 불가. **버튼 표시와 결제창 열림은 다르며 후자는 검증하지 못했다.**
- 필요한 환경변수 **이름**(값 금지): `NEXT_PUBLIC_PAYMENT_PROVIDER=nicepay`, `NEXT_PUBLIC_PG_CHECKOUT_ENABLED`(일반 회원 노출 — 심사 중에는 켜지 않음), `NICEPAY_CHECKOUT_ENABLED`, `NICEPAY_API_FAMILY`, `NICEPAY_ENV`, `NICEPAY_RETURN_BASE_URL`, rest_v1: `NICEPAY_CLIENT_ID`·`NICEPAY_SECRET_KEY` / v3_mid: `NICEPAY_MID`(단건 `mwhabit01m` 발급 예정)·`NICEPAY_MERCHANT_KEY`, `PAYMENT_RETURN_TOKEN_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`.
- 통합 충돌: 준비 브랜치와 코드 파일은 자동 병합, `docs/CHANGELOG.md`·`docs/TODO.md` 만 충돌(양쪽 유지로 해결). 준비 브랜치는 Toss/PortOne 신규 결제를 제거하는 큰 변경이라 이번 작업에서 병합하지 않았다(별도 승인).

## 6. 재현(로컬 격리 스택, 운영 아님)
`supabase start --workdir isolated-supabase …` → `node scripts/isolated/bootstrapEphemeral.mjs --out <env>` → SQL 적용(위 순서) → `ISO_ENV_FILE=<env> scripts/isolated/nicepayReview/setupLocal.sh` 후 `node scripts/isolated/nicepayReview/{permissionMatrix,reservationGuard,flagTamper,mismatchedCenterRepro,rollbackScenarios,browserHistoryCategory}.mjs` — 모든 스크립트는 네트워크 요청 전에 일회용 로컬 스택인지 검사한다(`assertIsolated.mjs`)..

## 7. 남은 정책 결정(임의 확정하지 않음)
1. 심사관 계정이 **운영 센터의 회원/매니저/플랫폼 관리자 역할을 겸하면** 어떻게 할지(현재: 매니저·플랫폼 관리자 센터는 예외로 보임, 회원 관계만인 운영 센터는 숨김). 가능하면 심사 전용 별도 계정 권장. 지정 대상 `sonjw222@naver.com` 이 운영 계정인지 운영 DB 에서 확인되지 않음(조회 권한 없음).
2. 심사관의 운영 센터 기존 이력(수강권·예약·주문) 화면 표시 범위 — 현재 이력 행은 보이나 센터 정보는 숨겨질 수 있음.
3. 상품 가격·이용기간·서비스 내용, 심사 센터에 수업(클래스)을 둘지, 센터 주소·사업자 정보 표기.
4. 심사 종료 후 처리(플래그 해제·센터 비공개/삭제).
5. 준비 브랜치 병합 시점과 NICEPAY 활성화 일정.

## 8. NICEPAY 에 별도 고지할 사항
심사 전용 센터·상품 제공 사실, 심사 계정은 별도 경로로 전달(저장소·채팅 금지), 심사 상품은 심사용 거래이며 일반 회원에게 비노출·일반 PG 결제는 비활성, 결제창 접근 가능 시점(MID·키 설정 + 코드 활성화 후), 실결제 승인 금지/취소 방법 합의.
