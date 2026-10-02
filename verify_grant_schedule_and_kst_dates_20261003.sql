-- READ-ONLY(단일 SELECT): fix_grant_schedule_and_kst_dates_20261003.sql 적용 상태 확인. 모든 *_ok가 true일 때만 verdict='APPLIED'(적용 전에는 NOT_APPLIED가 정상).
with f as (
    select
        pg_get_functiondef('public.manager_grant_product(uuid,uuid,uuid,integer,text,text,timestamp with time zone,uuid,integer,time without time zone,text,integer)'::regprocedure) as g,
        pg_get_functiondef('public.cancel_reservation(uuid)'::regprocedure) as c,
        pg_get_functiondef('public.reserve_with_goods(uuid,uuid,uuid,uuid)'::regprocedure) as w
), h as (
    select p.oid, p.prosecdef, p.proconfig::text as cfg
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'validate_product_schedule_selection'
), u as (
    select p.prosrc as src from pg_proc p where p.oid = (select oid from pg_proc where proname = 'update_class_safe' and pronamespace = 'public'::regnamespace limit 1)
), cks as (
    select
        (g like '%validate_product_schedule_selection(v_product.id, v_bound_dow, v_bound_time)%')                        as grant_validates_schedule_ok,
        (g !~ 'current_date' and g like '%Asia/Seoul%')                                                                   as grant_kst_dates_ok,
        (c !~ 'current_date' and c like '%expires_at >= (now() at time zone ''Asia/Seoul'')::date%')                       as cancel_reservation_kst_ok,
        (select position('search_path' in pg_get_functiondef('public.cancel_reservation(uuid)'::regprocedure)) > 0)       as cancel_reservation_search_path_ok,
        (w !~ 'current_date')                                                                                             as goods_reservation_kst_ok,
        ((select src from u) !~ 'current_date')                                                                           as update_class_safe_kst_ok,
        exists (select 1 from h)                                                                                          as helper_exists_ok,
        coalesce((select prosecdef from h), false)                                                                        as helper_security_definer_ok,
        coalesce((select cfg like '%search_path=public%' from h), false)                                                  as helper_search_path_ok,
        coalesce((select not has_function_privilege('anon', oid, 'execute') and not has_function_privilege('authenticated', oid, 'execute') and not has_function_privilege('public', oid, 'execute') from h), false) as helper_internal_only_ok
    from f
)
select cks.*,
       case when grant_validates_schedule_ok and grant_kst_dates_ok and cancel_reservation_kst_ok and cancel_reservation_search_path_ok and goods_reservation_kst_ok
                 and update_class_safe_kst_ok and helper_exists_ok and helper_security_definer_ok and helper_search_path_ok and helper_internal_only_ok
            then 'APPLIED' else 'NOT_APPLIED' end as verdict
from cks;
