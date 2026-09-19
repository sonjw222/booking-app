-- ============================================================
-- Web QA P2 Fix Batch(2026-09-19) — P2-45: 매출 표시 불일치
--
-- 근본 원인: registerPayment()(lib/sales.ts)는 환불(sale_type='refund')일 때
-- total_amount만 음수로 저장하고, card_amount/cash_amount/transfer_amount/
-- point_amount는 계속 양수 그대로 저장해왔다(스키마 주석에는 total_amount만
-- "환불이면 음수"라고 명시돼 있어, 애초에 의도가 아니었던 것으로 보임).
--
-- 그 결과 "결제수단별" 합계(app/manager/sales의 summarize(), 그리고
-- manager_dashboard_summary() RPC의 byMethod 둘 다 이 4개 컬럼을 그대로 SUM)는
-- 환불을 전혀 반영하지 못해, 이미 환불을 반영한 total_amount 기반 "총 매출"과
-- 항상 어긋났다(QA 실측: 2026.09.01~09.19 통합테스트센터에서 총 매출
-- 6,375,000원 vs 카드+현금 합계 6,550,000원, 175,000원 차이 — 정확히 그 기간
-- 환불 레코드들의 카드/현금 금액 합과 일치).
--
-- 이 파일은 코드 수정(lib/sales.ts, registerPayment가 이제 환불 시 이 4개
-- 컬럼도 음수로 저장함)과 짝을 이루는 "기존 데이터 백필"이다 — 코드 수정은
-- 앞으로 새로 생성되는 환불 건만 고치므로, 이미 저장된 과거 환불 건은 이
-- UPDATE로 별도 보정해야 한다.
--
-- 영향받는 데이터: payments 테이블 중 sale_type='refund'이면서 4개 결제수단
-- 컬럼 중 하나라도 양수인 행. 기존 값을 절대값 기준으로 음수 반전만 한다
-- (금액 자체를 새로 계산하거나 삭제하지 않음). direct_amount는 registerPayment()가
-- 애초에 설정하지 않는 컬럼이라(항상 0) 이 백필 대상에서 제외했다.
--
-- 재실행 안전(idempotent): WHERE 조건이 "값이 여전히 양수인 행"만 골라내므로,
-- 이미 이 UPDATE를 한 번 실행한 뒤 다시 실행해도 두 번째부터는 대상 행이 없어
-- 아무 것도 바뀌지 않는다.
--
-- 위험도: 낮음(부호만 바꿈, 행 삭제/컬럼 삭제 없음). 실행 전 총 영향 행 수를
-- 먼저 확인하는 SELECT를 맨 위에 둔다.
-- ============================================================

-- 0) 실행 전 확인: 몇 건이 바뀔지 먼저 확인하고 싶으면 이 SELECT만 먼저 실행.
-- select id, center_id, sale_type, card_amount, cash_amount, transfer_amount,
--        point_amount, total_amount, paid_at
-- from payments
-- where sale_type = 'refund'
--   and (card_amount > 0 or cash_amount > 0 or transfer_amount > 0 or point_amount > 0);

BEGIN;

update payments
set
    card_amount     = -abs(card_amount),
    cash_amount     = -abs(cash_amount),
    transfer_amount = -abs(transfer_amount),
    point_amount    = -abs(point_amount)
where sale_type = 'refund'
  and (card_amount > 0 or cash_amount > 0 or transfer_amount > 0 or point_amount > 0);

COMMIT;

-- ============================================================
-- 실행 후 확인
-- ============================================================
-- 아래 SELECT는 0건이 나와야 정상(더 이상 양수로 남은 환불 결제수단 금액이 없음).
-- select count(*) from payments
-- where sale_type = 'refund'
--   and (card_amount > 0 or cash_amount > 0 or transfer_amount > 0 or point_amount > 0);
