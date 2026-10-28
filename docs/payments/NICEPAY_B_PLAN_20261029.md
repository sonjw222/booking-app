# NICEPAY 심사 — 전용 권한 분리(B안)·운영 이력 대조·v3 결제창 준비 (2026-10-29)

브랜치 `feat/nicepay-review-integrated-20261029` = `5b8f1fa`(센터 분리 점검) + 준비 브랜치(`6a847ee`) 로컬 병합 + B안·v3 변경. 운영 DB 변경·SQL 실행·계정 변경·데이터 생성·Push/PR/병합/배포·결제 활성화 없음(운영은 읽기 전용 조회만).

## 1. B안 — 확정 결정의 구현
- **새 권한** `accounts.nicepay_review_access`(운영자만 변경, 트리거 보호). NICEPAY 심사 센터 노출·NICEPAY 결제 게이트·결제수단 노출은 이 값만 본다. 기존 `pg_checkout_override`(토스)는 **유지·무변경**.
- **읽기 가시성 vs 회원용 판정을 분리**: `nicepay_review_center_allowed`(RLS 읽기: 매니저·플랫폼 관리자 예외 유지 → 관리 화면은 기존 권한대로) / `nicepay_review_center_member_allowed`(탐색 목록 RPC·주문·예약·수강권·장바구니·구매신청: NICEPAY 심사관에게는 매니저 예외 없음 → 심사 센터에서만 가능).
- **탐색(홈·검색·종목·문의 센터 검색)**: 서버 RLS 는 매니저 센터를 관리 화면용으로 읽게 두므로, 앱이 NICEPAY 심사관에게만 탐색 쿼리에 `is_nicepay_review=true` 를 추가한다(`lib/nicepayReviewScope.ts`). 일반 회원 쿼리는 그대로.
- **결제수단 노출**: PG 가 NICEPAY 이면 `fetchMyNicepayReviewAccess()`, 아니면 기존 `fetchMyPgCheckoutOverride()`(`app/checkout`, `app/cart`).
- **NICEPAY 결제 게이트**: 운영에 이미 적용된 `orders_guard_nicepay_create`·`nicepay_claim_order` 가 토스용 override 로 심사관을 판별하던 것을 `fix_nicepay_gate_reviewer_flag_20261029.sql` 로 전용 권한으로 치환(서버 `nicepayGate` 도 동일).
- **sonjw222 와 기존 Toss 심사 센터 매니저 관계**: 삭제·변경하지 않음. 관리 화면(`/manager`)은 그대로 열리고, 탐색에서는 NICEPAY 심사 센터만 보이며, Toss 센터는 직접 URL(매니저)로만 열린다. 그 센터의 상품 구매·예약은 심사관에게 차단된다.
**변경 파일(B안·v3·종료절차)**: `add_nicepay_review_center_isolation_20261028.sql`·`rollback_…`·`verify_…`·`preflight_…`, 신규 `fix_nicepay_gate_reviewer_flag_20261029.sql`(+rollback·verify), `close_nicepay_review_20261029.sql`, `lib/authAccount.ts`, `lib/nicepayReviewScope.ts`(신규), `lib/home.ts`, `lib/inquiries.ts`, `app/checkout/page.tsx`, `app/cart/page.tsx`, `lib/payments/server/nicepay/runtime.ts`, `lib/payments/NicepayPaymentProvider.ts`, `lib/payments/nicepayV3Window.ts`(신규), 테스트 7개(신규·수정), `scripts/isolated/nicepayReview/*`, 문서.

## 2. Toss 심사 계정 영향 — 없음(로컬 격리 검증)
| 페르소나 | 센터 목록 | 운영 센터 구매 | Toss 센터 | 심사 센터 | NICEPAY 게이트(reviewer 모드) |
|---|---|---|---|---|---|
| 일반 회원 A | 운영 | 가능 | 직접 URL 불가 | 불가 | 거부 |
| **토스 심사관 T(override만)** | 운영 + Toss 센터(회원) | **가능(변경 없음)** | 가능 | **불가** | **거부**(결제수단도 직접결제만 — NICEPAY 모드에서 override 무시) |
| **NICEPAY 심사관 B(전용 권한만)** | **심사 센터만** | 불가 | 불가 | 가능 | **통과(심사 센터 상품만)** |
| **S = sonjw 형태(is_member=false·Toss 센터 매니저·전용 권한)** | 심사 센터만(탐색) | 불가 | 관리 화면·직접 URL 가능, 구매 불가 | 가능 | 통과(심사 센터 상품만) |
| 운영 센터 매니저 MA | 운영 | 가능 | 불가 | 불가 | 거부 |
| 심사 센터 매니저 MB | 운영+심사 | 가능 | 불가 | 가능 | 거부(심사관 아님) |
| 플랫폼 관리자 | 전체 | - | 가능 | 가능 | - |
**결함 재현(게이트 패치 전)**: reviewer 모드에서 토스 심사 계정 T 가 **운영 센터 상품으로 NICEPAY 주문을 만들 수 있었다**(`gate-matrix-BEFORE-gate-patch.json`) → 패치 후 거부. (B안을 적용하지 않고 센터 분리만 하면 이 구멍이 남는다.)

## 3. NICEPAY 심사 계정의 구매 가능 여부
- `is_member=false` 가 구매를 막는지 **로컬 재현**: 막지 않는다 — 주문 RPC·직접결제 주문 접수(UI "주문 접수하기" → 주문 201 생성·성공 화면)·주문 취소 모두 통과. 프로필이 있으면 충분하다(운영 계정은 프로필 1개). 한 번의 실행에서 "로그인이 필요해요"가 나온 것은 카테고리 화면을 거친 직후 세션 복원 타이밍에서 상품 목록이 공개 모델로 대체된 기존 레이스였고, 재실행 2회에서는 재현되지 않았다(이번 변경과 무관, 별도 관찰 항목).
- 카드 결제: 심사관(B·S)은 결제수단(카드 등)이 보이지만 **누르면 "온라인 결제는 준비 중"으로 주문 생성 전에 차단**(코드 상수 `NICEPAY_CHECKOUT_ACTIVATED=false`). 일반 회원은 직접결제만.
- 운영에서의 구매 가능 여부는 확인하지 못했다(운영 계정 로그인·구매 금지).

## 4. 운영 SQL 이력 대조
`NICEPAY_SQL_RUNBOOK_20261028.md` 상단 표 참조. 요약: 6건 이미 적용(본문 대조 일치), `fix_refund_pg_origin_guard` 는 이력 없음→정의 확인 필요, `fix_nicepay_claim_gate` 는 불필요, 기간 RPC·분리 SQL 은 미적용, **게이트 판별 패치는 B안으로 신규 필요**. 정의 해시 대조는 BLOCKED(SQL 실행 채널 없음).

## 5. v3 결제창 — 구현·검증 결과
공식 문서(`developers.nicepay.co.kr/docs/pg/auth/payment-window/`) 대조:
| 문서 요구 | 구현 | 검증 |
|---|---|---|
| `nicepay-pgweb.js` 로드(`https://pg-web.nicepay.co.kr/v3/common/js/nicepay-pgweb.js`) | 허용 URL 목록에 추가, 로드 후 `goPay` 확인 | jsdom 단위 |
| form 필드 MID·Moid·Amt·GoodsName·EdiDate·SignData·PayMethod(+ReturnURL 모바일 필수·CharSet) | 허용 필드만 form 에 넣음(서버가 준 파라미터) | 단위(필드 일치) |
| `goPay(form)`, 콜백 `nicepaySubmit()`·`nicepayClose()` 고정 이름 | 전역 콜백 정의: submit→서버 ReturnURL 로 form 제출, close→제출 없으면 유예 후 pending 주문 abandon | 단위(제출·닫힘 유예) |
| SignData = hex(sha256(EdiDate+MID+Amt+MerchantKey)), 서버에서 생성, 키 노출 금지 | 서버 `handlePrepare` 가 생성(이미 구현), 응답·form 에 키 없음, 비밀 이름 필드는 브라우저가 거부 | 단위(공식 공식과 일치·응답에 키 없음) |
| 금액·주문 일치 | 서버는 DB 주문 금액만 사용, 브라우저는 Moid/Amt 가 화면 주문과 다르면 결제창을 열지 않음, ReturnURL 은 같은 출처·`/api/payments/nicepay/return` 만 | 단위 |
| 모바일: ReturnURL 로 인증 응답, PC: nicepaySubmit 후 form action | form action=ReturnURL(PC), ReturnURL 필드(모바일) — 같은 서버 라우트가 받음 | 단위(구조)·실기기 미검증 |
| 인증 성공 ≠ 승인 | 브라우저 모듈에 승인 코드 없음(정적 테스트). 승인·망취소·Signature(AuthToken+MID+Amt+Key) 검증은 기존 서버 모듈(`handleNicepayAuthReturn`)이 수행 | 기존 오프라인 테스트 |
| Toss 와 구분 | provider=`nicepay` 주문만(`orders.payment_provider`), Toss 경로는 준비 브랜치에서 신규 결제 비활성 | 기존 테스트 |
**검증하지 못한 것(BLOCKED)**: 실제 `nicepay-pgweb.js` 로딩과 결제창 열림(MID·키·샌드박스 없음) — **PASS 아님**. 또한 ① 문서의 "인코딩은 EUC-KR 로만 설정" — 현재 form `accept-charset="euc-kr"`+`CharSet=utf-8`(응답)로 구현했으나 한글 상품명 처리는 샌드박스에서 확인 필요(필요하면 상품명 ASCII 처리), ② 앱 WebView 연동 시 필수인 `WapUrl`·`IspCancelUrl`(미구현), ③ 결제창 취소(닫기) 이벤트 시점, ④ 모바일 실기기 ReturnURL 복귀, ⑤ `NICEPAY_RETURN_BASE_URL` 은 https 필수라 로컬(http)에서 서버 prepare E2E 불가(가짜 deps 단위 테스트로 대체), ⑥ `mwhabit01m` 이 실제 v3 계약인지(키 계열 확인).

## 6. 심사 환경(D)
시드·가격·내용은 확정하지 않고 초안 보존. **NICEPAY 가 심사 전용 센터·상품 노출 방식을 허용하는지는 BLOCKED 유지.** 종료 절차: `close_nicepay_review_20261029.sql`(권한 해제·게이트 off·센터 비공개·대기 주문 정리, 기존 센터·토스 계정·결제 기록 불변). 로컬에서 실행해 확인: 권한 0명, 게이트 off, 심사 센터 일반 비공개, 이후 **분리 SQL 롤백이 허용**(공개 가능한 심사 센터가 있으면 롤백은 계속 중단).

## 7. 통합 QA(E) — 변경 전후
- 단위 2796 통과, 빌드 성공, 린트 신규 0, 타입체크 통과(`productsPurchaseGuide` 주소 단언 충돌 수정).
- **전(분리 전·`evidence/permission-matrix-before-isolation.json`)**: 전원에게 심사 센터·상품 노출, 불일치 주문 통과. **후(`permission-matrix-b1-dedicated-flag.json`, `gate-matrix.json`, `personas/`)**: 위 §2 표. 브라우저 5 페르소나 × 390/1440 × 라이트/다크: 4조합 결과 불일치 0, 페이지 오류 0.
- 한계: 홈·종목 화면 스크린샷은 용량 때문에 보존하지 않음(결과 JSON 은 보존), 실기기·WebKit/Firefox 미검증, 운영 환경 미검증.

## 8. 별도 관찰(이번 변경과 무관, 운영 미확인)
로컬 DEV 기준선에서 일반 회원이 **내부 센터(is_internal)의 상품을 UUID 로 주문(RPC)** 할 수 있었다(Toss 심사 센터 상품 주문 OK). 운영 동작은 확인하지 않았다 → 후속 점검 필요.
