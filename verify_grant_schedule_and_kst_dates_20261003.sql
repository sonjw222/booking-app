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
    select pg_get_functiondef(p.oid) as src from pg_proc p where p.proname = 'update_class_safe' and p.pronamespace = 'public'::regnamespace limit 1
), e as (
    select pg_get_functiondef('public.is_membership_eligible_for_class(uuid,uuid)'::regprocedure) as elig
), cks as (
    select
        (g like '%validate_product_schedule_selection(v_product.id, v_bound_dow, v_bound_time)%')                        as grant_validates_schedule_ok,
        (g !~ 'current_date' and g like '%Asia/Seoul%')                                                                   as grant_kst_dates_ok,
        (c !~ 'current_date' and c like '%expires_at >= (now() at time zone ''Asia/Seoul'')::date%')                       as cancel_reservation_kst_ok,
        (select position('search_path' in pg_get_functiondef('public.cancel_reservation(uuid)'::regprocedure)) > 0)       as cancel_reservation_search_path_ok,
        (w !~ 'current_date')                                                                                             as goods_reservation_kst_ok,
        ((select src from u) !~ 'current_date')                                                                           as update_class_safe_kst_ok,
        -- 대기 승격 자격(cancel_reservation / update_class_safe 둘 다): 예약 자격과 같은 5개 조건이 모두 있어야 한다
        (c like '%m.status = ''active''%' and (select src from u) like '%m.status = ''active''%')                          as waitlist_promotion_status_ok,
        (c like '%m.remaining_count is null or m.remaining_count > 0%' and (select src from u) like '%m.remaining_count is null or m.remaining_count > 0%') as waitlist_promotion_unlimited_count_ok,
        (c like '%m.expires_at is null or m.expires_at >= (now() at time zone ''Asia/Seoul'')::date%' and (select src from u) like '%m.expires_at is null or m.expires_at >= (now() at time zone ''Asia/Seoul'')::date%') as waitlist_promotion_expiry_ok,
        (c like '%m.starts_at is null or m.starts_at <= (now() at time zone ''Asia/Seoul'')::date%' and (select src from u) like '%m.starts_at is null or m.starts_at <= (now() at time zone ''Asia/Seoul'')::date%') as waitlist_promotion_starts_ok,
        (c like '%is_membership_eligible_for_class(m.id, v_res.class_id)%' and (select src from u) like '%is_membership_eligible_for_class(m.id, p_class_id)%') as waitlist_promotion_current_class_eligibility_ok,
        -- 승격 시 membership_consumed = true도 함께(대기 등록 시 false) — 차감과 같은 성공 경로
        (c like '%set status = ''confirmed'', waitlist_order = null, membership_consumed = true%' and (select src from u) like '%set status = ''confirmed'', waitlist_order = null, membership_consumed = true%') as waitlist_promotion_consumed_ok,
        -- 선행 조건: 예약 무결성 migration(정확 일치 + pass-only)이 적용된 is_membership_eligible_for_class를 재사용한다(이 migration은 그 함수를 다시 정의하지 않는다)
        ((select elig from e) like '%r.class_title = c.title%' and (select elig from e) like '%pd.product_kind = ''pass''%') as eligibility_function_prereq_ok,
        exists (select 1 from h)                                                                                          as helper_exists_ok,
        coalesce((select prosecdef from h), false)                                                                        as helper_security_definer_ok,
        coalesce((select cfg like '%search_path=public%' from h), false)                                                  as helper_search_path_ok,
        coalesce((select not has_function_privilege('anon', oid, 'execute') and not has_function_privilege('authenticated', oid, 'execute') and not has_function_privilege('public', oid, 'execute') from h), false) as helper_internal_only_ok
    from f
)
select cks.*,
       case when grant_validates_schedule_ok and grant_kst_dates_ok and cancel_reservation_kst_ok and cancel_reservation_search_path_ok and goods_reservation_kst_ok
                 and update_class_safe_kst_ok and waitlist_promotion_status_ok and waitlist_promotion_unlimited_count_ok and waitlist_promotion_expiry_ok
                 and waitlist_promotion_starts_ok and waitlist_promotion_consumed_ok and waitlist_promotion_current_class_eligibility_ok and eligibility_function_prereq_ok and helper_exists_ok and helper_security_definer_ok and helper_search_path_ok and helper_internal_only_ok
            then 'APPLIED' else 'NOT_APPLIED' end as verdict
from cks;
