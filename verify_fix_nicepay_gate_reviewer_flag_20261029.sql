-- 읽기 전용 확인(P2b 적용 후): 모두 true 여야 한다.
--  · 두 게이트 함수가 새 권한과 심사 센터 소속 검증(nicepay_order_is_review_target)을 쓰고, 옛 토스 플래그는 코드에서 쓰지 않는다
--  · 정의 해시가 이 파일 적용본과 같다(721bef6e27646547535cfe7b05393f88/d7145831da2f416612818d2e4fe5d5fc) · helper 존재·PUBLIC 실행 불가
select p.proname,
       position('nicepay_review_access' in pg_get_functiondef(p.oid)) > 0 as uses_new_flag,
       position('nicepay_order_is_review_target' in pg_get_functiondef(p.oid)) > 0 as checks_review_target,
       position('pg_checkout_override' in pg_get_functiondef(p.oid)) > 0 as still_uses_old_flag_must_be_false,
       md5(pg_get_functiondef(p.oid)) = case p.proname when 'orders_guard_nicepay_create' then '721bef6e27646547535cfe7b05393f88' else 'd7145831da2f416612818d2e4fe5d5fc' end as definition_matches_expected
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname in ('orders_guard_nicepay_create', 'nicepay_claim_order') order by 1;
select to_regprocedure('public.nicepay_order_is_review_target(uuid,uuid)') is not null as helper_exists,
       (select position('is_on_sale' in pg_get_functiondef(to_regprocedure('public.nicepay_order_is_review_target(uuid,uuid)'))) > 0 and position('is_internal' in pg_get_functiondef(to_regprocedure('public.nicepay_order_is_review_target(uuid,uuid)'))) > 0 and position('p_product_id is not null' in pg_get_functiondef(to_regprocedure('public.nicepay_order_is_review_target(uuid,uuid)'))) > 0) as helper_requires_approved_center_and_on_sale_product,
       not has_function_privilege('public', to_regprocedure('public.nicepay_order_is_review_target(uuid,uuid)')::oid, 'execute') as helper_not_executable_by_public,
       not has_function_privilege('authenticated', to_regprocedure('public.nicepay_order_is_review_target(uuid,uuid)')::oid, 'execute') as helper_not_executable_by_authenticated,
       (select mode from nicepay_checkout_gate where id) as gate_mode_info;
