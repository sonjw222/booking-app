-- fix_nicepay_gate_reviewer_flag_20261029.sql 되돌리기: 두 함수의 심사관 판별을 다시 accounts.pg_checkout_override 로 역치환(그 외 로직 불변).
-- 주의: 되돌리면 토스 심사 계정(override)이 mode='reviewer' 에서 NICEPAY 주문을 만들 수 있다.
begin;
do $$
declare v_sig text; v_def text;
begin
    foreach v_sig in array array['public.orders_guard_nicepay_create()', 'public.nicepay_claim_order(uuid)'] loop
        if to_regprocedure(v_sig) is null then continue; end if;
        select pg_get_functiondef(to_regprocedure(v_sig)) into v_def;
        if position('nicepay_review_access' in v_def) > 0 then execute replace(v_def, 'nicepay_review_access', 'pg_checkout_override'); end if;
    end loop;
end $$;
commit;
