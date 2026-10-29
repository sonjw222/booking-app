# 만료 상품 기존 pending 주문 처리 (2026-10-31, 로컬 구현·검증 — 운영 SQL 미실행)

PR #251(만료 고정일 상품 신규 주문 차단) 위에 쌓은 기능. 이미 접수돼 있던 직접결제 pending 주문을 관리자가 안전하게 정리한다.

## 정책
1. 미수납 확인 → `cancelled`(수강권·매출 없음, 포인트·쿠폰 복원은 기존 트리거 그대로).
2. 수납 확인 + 환불 → 수납 금액(주문 금액과 같아야 함)·수납일·수단 기록 → **환불 예정**(주문 pending 유지, payments 행 없음) → 센터가 실제 환불 후 ‘환불 완료 확인’ → `cancelled`. 환불 전에는 완료 처리 불가.
3. 수납 확인 + 이용기간 조정 → 새 만료일(오늘 KST 이후)+사유. 결제 확인·수강권 발급·기간 조정·매출이 하나의 서버 트랜잭션(오류 시 전부 롤백). 상품 `expiry_date` 불변, 그 주문의 수강권 1건에만 적용.
4. 수납 불명 → 서버 동작 없음(주문 대기 유지). 자동 취소·발급·환불 없음.

## 서버
- 테이블 `order_expiry_resolutions`(RLS: 관리자 조회만, 쓰기는 RPC만), RPC `manager_resolve_expired_order`(SECURITY DEFINER, 행 잠금, `pass.payment.create` — fulfill_order 와 같은 권한, 직접결제 주문만).
- `fulfill_order` 제자리 패치: 만료 상품 주문은 RPC 경유(GUC)가 아니면 거부 → 직접 호출 우회 차단. 패치 전/후 정의 해시 가드(운영 `b675acdd9c48bba4b4a80891cbba0a76` → `935b66bebdd126ef7d36a80237036924`), 불일치 시 전체 중단.
- 클라이언트 UPDATE 가드 트리거 `orders_guard_expired_resolution`(실행 역할 authenticated/anon 일 때만): 대기 주문의 제공자·결제수단·상품·금액·센터·회원 변경 불가, 만료 상품·처리 기록 주문(PG 승인 이력 없음)은 일반 취소·확정 등 모든 상태 변경 불가(OLD 기준). 서버 경로(definer 함수·service_role)는 대상 아님. 내부 인증은 세션 설정이 아닌 `order_expiry_authz`(txid 한정 행, 클라이언트 접근 불가).
- NICEPAY·기존 PG 경로 불변(해시·결제 상수 false 시험 포함).

## 적용 순서(운영, 승인 후)
PR #251 SQL(preflight → fix → verify) → `preflight_add_expired_order_resolution_20261031.sql` → `add_expired_order_resolution_20261031.sql` → `verify_add_expired_order_resolution_20261031.sql` → 앱 배포. 롤백: `rollback_add_expired_order_resolution_20261031.sql`(환불 예정 행이 있으면 중단, 이력 있는 테이블은 보존).

## 시험(격리 로컬 스택)
`scripts/isolated/expiredOrder/verify.mjs`(58), `tests/sql/expired-order-resolution.test.mjs`(PGlite, 기본 CI), `tests/unit/expiredOrderResolution.test.ts`, `tests/expired-order-qa`(Playwright 데스크톱+모바일 12). 결과: `docs/qa/expired-order-handling-20261031/`.
