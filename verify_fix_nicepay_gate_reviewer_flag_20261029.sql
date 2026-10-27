-- 읽기 전용 확인: 두 함수가 전용 권한을 보는지(둘 다 true, old_flag 는 false 여야 함)
select p.proname,
       position('nicepay_review_access' in pg_get_functiondef(p.oid)) > 0 as uses_new_flag,
       position('pg_checkout_override' in pg_get_functiondef(p.oid)) > 0 as still_uses_old_flag_must_be_false
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname in ('orders_guard_nicepay_create', 'nicepay_claim_order');
