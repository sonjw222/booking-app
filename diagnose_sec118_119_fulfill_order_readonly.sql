-- ============================================================
-- SEC-118/SEC-119 진단 전용 — 100% READ-ONLY, 아무것도 바꾸지 않음.
-- fulfill_order()의 실제 Live 본문을 확정하고(SEC-119, migration ledger 갭),
-- orders.amount 검증 여부를 재확인한다(SEC-118). 이번 배치(SEC-114~117)와
-- 완전히 분리 — 이 파일은 그 무엇도 수정하지 않으며, 수정 SQL은 별도 후속
-- 배치에서 사용자 승인 후 설계한다.
-- ============================================================

-- [1] 실제 Live fulfill_order() 전문 확인 — auto_book_membership 내부 호출이
--     있는지(add_auto_booking.sql 계열) 없는지(add_refund_and_membership.sql
--     계열)로 어느 git 버전이 실제 적용돼 있는지 바로 판별 가능.
select pg_get_functiondef('fulfill_order(uuid)'::regprocedure);

-- [2] orders.amount에 DB 레벨 제약이 있는지(현재는 없는 것으로 git에서 확인됨 —
--     CHECK 제약, FK, trigger 전부 없음). Live에서 재확인.
select conname, pg_get_constraintdef(oid)
from pg_constraint
where conrelid = 'orders'::regclass;

select tgname, tgenabled
from pg_trigger
where tgrelid = 'orders'::regclass and not tgisinternal;

-- [3] orders INSERT RLS policy 원문 재확인(amount 관련 제약이 전혀 없는지).
select policyname, cmd, qual, with_check
from pg_policies
where tablename = 'orders';

-- [4] 실제 Live confirm_test_payment() 전문 확인 — Mock 결제(회원 self-checkout)의
--     실제 발급 경로. fulfill_order와 별개로 orders.amount를 그대로 신뢰하는지 확인.
select pg_get_functiondef('confirm_test_payment(uuid, text)'::regprocedure);

-- [5] orders.verified 컬럼이 이미 존재하는지(적용 전이면 0건 아님, 컬럼 자체가 없어서
--     에러가 날 수 있음 — 에러 나면 = 아직 미적용이라는 뜻).
select column_name, data_type, column_default
from information_schema.columns
where table_name = 'orders' and column_name = 'verified';
