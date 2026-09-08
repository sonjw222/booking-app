-- ============================================================
-- payments.sale_type에 "서비스"(무상 지급) 값 추가
--
-- 배경: 매니저가 회원에게 수강권/상품을 서비스(증정)로 지급하는 기능을 만들면서,
-- 그 발송 이력을 매출 목록에서 "신규결제" 등과 구분해서 남기려고 sale_type에
-- 'service'를 추가한다(가격 0원 지급은 total_amount=0이라 매출액에는 안 잡히지만,
-- 몇 건이나 서비스로 나갔는지는 구분해서 봐야 함).
--
-- DB 재생성 불필요. 파일 전체를 Supabase SQL Editor에 붙여넣고 Run 하세요.
-- 여러 번 실행해도 안전(같은 이름의 제약을 지우고 다시 만듦).
-- ============================================================

alter table payments drop constraint if exists payments_sale_type_check;
alter table payments add constraint payments_sale_type_check
    check (sale_type in (
        'new', 'renew', 'trial', 'upgrade', 'refund', 'unpaid_pay', 'transfer_fee',
        'service'  -- 무상 지급(증정) — total_amount는 항상 0
    ));
