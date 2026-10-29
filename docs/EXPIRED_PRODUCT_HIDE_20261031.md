# 만료 상품 자동 노출 종료 및 신규 구매 차단 (2026-10-31)

**운영 SQL 미실행 — 제안 세트.** 앱 코드는 이 브랜치에 있고, 서버 규칙(SQL)은 사용자 승인 후 별도 적용한다. SQL 적용 전에도 클라이언트 방어선이 목록에서 만료 상품을 숨긴다(신규 주문 차단은 SQL 적용 후).

## 규칙
`products.expiry_mode = 'date'` 이고 `expiry_date < (now() at time zone 'Asia/Seoul')::date` → 구매 불가(목록 제외 + 신규 주문 거부). 오늘·미래 만료일은 노출. `days`/`rolling_month`/`none` 은 기존 동작. 데이터는 바꾸지 않는다(cron·UPDATE 없음, 조회 시점 계산).

## 변경
| 영역 | 파일 | 내용 |
|---|---|---|
| SQL(제안) | `preflight_/fix_/verify_/rollback_fix_expired_fixed_date_products_20261031.sql` | 헬퍼 2 + 목록 함수 3 + `create_order_secure` + orders INSERT 정책 |
| 클라이언트 | `lib/servicePeriod.ts`, `lib/useKstToday.ts`(신규), `lib/center.ts`, `lib/orders.ts`, `app/products/page.tsx`, `app/center/[id]/page.tsx`, `app/components/ServicePeriodNotice.tsx` | 만료 필터(방어선·날짜 롤오버), 종료일<시작일 문구 차단, RLS 거부 안내 문구 |
| 테스트 | `tests/sql/expired-fixed-date-products.test.mjs`(PGlite), `tests/unit/expiredProductHide.test.ts`, `tests/expired-product-qa/`(Chromium 수동), `scripts/isolated/expiredProduct/verify.mjs` | |

## 일부러 바꾸지 않은 것
- `member_can_purchase_product(uuid,uuid)`: 결제 확정·발급(`_issue_membership_and_record_payment`)이 구매 자격 재확인에 쓴다. 바꾸면 **만료일 뒤 확정되는 기존 pending 주문이 "결제만 되고 수강권 미발급"** 이 될 수 있다. 신규 주문만 별도 함수(`product_fixed_expiry_passed`)·정책·`create_order_secure` 로 막는다.
- 관리자 상품 관리(`products` 직접 조회·수정)와 `manager_grant_product`(관리자 지급): 그대로 — 만료 상품을 계속 보고 만료일을 고칠 수 있다.
- 기존 구매내역·수강권·예약·환불·취소: 그대로(로컬 검증 H1~H4).

## 알아 둘 점(예상 밖 영향 후보 — 변경 안 함)
1. 만료일 이후에 **확정되는 기존 pending 주문**은 막지 않는다. 발급되는 수강권의 만료일은 상품의 (이미 지난) 고정 만료일이라 **이미 만료된 수강권**이 된다(기존 동작). 적용 전 사전 점검 SQL 의 `pending_orders_on_expired_products` 로 규모를 확인한다.
2. 장바구니에 담아 둔 만료 상품은 결제 시점에 "구매할 수 없는 상품" 으로 거부된다(주문 생성 단계).
3. NICEPAY P2 를 이 파일 **이후에** 재실행하면 목록 함수 3개가 옛 정의로 돌아간다(P2 는 운영에 이미 적용돼 재실행 대상 아님). 해시 가드가 이 파일 적용본·적용 전 정의 외의 정의에서는 중단한다.
4. CI 의 격리 스택(baseline) 에는 이 SQL 을 넣지 않았다(운영 정의 해시 가드 때문). 서버 동작은 PGlite 시험·로컬 격리 스택 시험으로 검증한다.

## 적용 순서·확인·롤백
1) `preflight_…`(읽기 전용: 해시·정책 일치·영향 상품) → 2) `fix_…`(한 트랜잭션, 가드 불일치 시 중단) → 3) `verify_…`(기대값) → 4) 앱 배포(순서 무관: 방어선이 있어 SQL 이 먼저여도 뒤여도 안전). 롤백: `rollback_fix_…`(적용본 해시일 때만, 적용 전 운영 해시로 복원).

## 후속(이번 범위 밖)
- Production 로그인 회원·관리자 QA 잔여(결제수단 화면, 직접결제 주문 안내, 허용·제한 직원 화면)
- NICEPAY P3 심사 센터·상품 준비(가격·기간 확정), 심사 전용 계정 준비
- Graphify(`graphify update .`)·NotebookLM 문서 갱신
