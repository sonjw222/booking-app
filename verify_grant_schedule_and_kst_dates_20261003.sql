-- READ-ONLY(단일 SELECT): fix_grant_schedule_and_kst_dates_20261003.sql 적용 상태 확인. 모든 *_ok가 true일 때만 verdict='APPLIED'(적용 전에는 NOT_APPLIED가 정상).
-- [formatting-safe] pg_get_functiondef() 문자열은 SQL Editor가 CRLF/들여쓰기/공백을 바꿔 저장할 수 있어 정확한 문자열 LIKE는 false-negative를 낸다.
--   함수 정의를 (1) 소문자, (2) -- 주석 제거, (3) 모든 공백 제거, (4) 'public.' 접두사 제거로 정규화한 뒤 position()으로 "의미 단위" 조건을 검사한다(정규화 문자열은 공백이 없으므로 패턴도 공백 없이 쓴다).
--   search_path / SECURITY DEFINER / 실행 권한은 정의 문자열이 아니라 pg_proc/권한 함수로 직접 확인한다.
with raw(k, t) as (
    values
    ('g',   pg_get_functiondef('public.manager_grant_product(uuid,uuid,uuid,integer,text,text,timestamp with time zone,uuid,integer,time without time zone,text,integer)'::regprocedure)),
    ('cr',  pg_get_functiondef('public.cancel_reservation(uuid)'::regprocedure)),
    ('w',   pg_get_functiondef('public.reserve_with_goods(uuid,uuid,uuid,uuid)'::regprocedure)),
    ('ucs', (select pg_get_functiondef(p.oid) from pg_proc p where p.proname = 'update_class_safe' and p.pronamespace = 'public'::regnamespace limit 1)),
    ('el',  pg_get_functiondef('public.is_membership_eligible_for_class(uuid,uuid)'::regprocedure))
), nd as (
    select k, replace(regexp_replace(regexp_replace(lower(t), '--[^\n\r]*', '', 'g'), '\s+', '', 'g'), 'public.', '') as n from raw
), d as (
    select max(n) filter (where k = 'g') as g, max(n) filter (where k = 'cr') as cr, max(n) filter (where k = 'w') as w,
           max(n) filter (where k = 'ucs') as ucs, max(n) filter (where k = 'el') as el from nd
), h as (
    select p.oid, p.prosecdef, p.proconfig::text as cfg
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'validate_product_schedule_selection'
       and pg_get_function_identity_arguments(p.oid) = 'p_product_id uuid, p_day integer, p_time time without time zone'
), crp as (
    select p.proconfig::text as cfg from pg_proc p where p.oid = 'public.cancel_reservation(uuid)'::regprocedure
), cks as (
    select
        -- B: manager_grant_product가 서버에서 상품 예약조건(요일/시간)을 검증
        (position('performvalidate_product_schedule_selection(v_product.id,v_bound_dow,v_bound_time)' in g) > 0)                        as grant_validates_schedule_ok,
        -- C: 지급 시작일/days형 만료가 KST 날짜(DB UTC current_date 아님)
        (position('current_date' in g) = 0 and position('v_startsdate:=(now()attimezone''asia/seoul'')::date' in g) > 0
            and position('((now()+(coalesce(v_product.expiry_days,0)||''days'')::interval)attimezone''asia/seoul'')::date' in g) > 0)  as grant_kst_dates_ok,
        (position('current_date' in cr) = 0 and position('asia/seoul' in cr) > 0)                                                        as cancel_reservation_kst_ok,
        (select coalesce(cfg like '%search_path=public%', false) from crp)                                                               as cancel_reservation_search_path_ok,
        (position('current_date' in w) = 0 and position('v_goods.expires_at<(now()attimezone''asia/seoul'')::date' in w) > 0
            and position('v_goods.starts_at>(now()attimezone''asia/seoul'')::date' in w) > 0)                                            as goods_reservation_kst_ok,
        (position('current_date' in ucs) = 0 and position('(now()attimezone''asia/seoul'')::date' in ucs) > 0)                           as update_class_safe_kst_ok,
        -- 대기 승격 자격(cancel_reservation / update_class_safe 둘 다): 예약 자격과 같은 조건
        (position('m.status=''active''' in cr) > 0 and position('m.status=''active''' in ucs) > 0)                                       as waitlist_promotion_status_ok,
        (position('m.remaining_countisnullorm.remaining_count>0' in cr) > 0 and position('m.remaining_countisnullorm.remaining_count>0' in ucs) > 0) as waitlist_promotion_unlimited_count_ok,
        (position('m.expires_atisnullorm.expires_at>=(now()attimezone''asia/seoul'')::date' in cr) > 0
            and position('m.expires_atisnullorm.expires_at>=(now()attimezone''asia/seoul'')::date' in ucs) > 0)                          as waitlist_promotion_expiry_ok,
        (position('m.starts_atisnullorm.starts_at<=(now()attimezone''asia/seoul'')::date' in cr) > 0
            and position('m.starts_atisnullorm.starts_at<=(now()attimezone''asia/seoul'')::date' in ucs) > 0)                            as waitlist_promotion_starts_ok,
        (position('is_membership_eligible_for_class(m.id,v_res.class_id)' in cr) > 0 and position('is_membership_eligible_for_class(m.id,p_class_id)' in ucs) > 0) as waitlist_promotion_current_class_eligibility_ok,
        -- 승격 = 같은 성공 경로(if found)에서 status/waitlist_order/membership_consumed 갱신 + NULL이 아닐 때만 차감
        (position('iffoundthenupdatereservationssetstatus=''confirmed'',waitlist_order=null,membership_consumed=truewhereid=v_next.id;updatemembershipssetremaining_count=remaining_count-1whereid=v_next_mem.idandremaining_countisnotnull;' in cr) > 0
            and position('iffoundthenupdatereservationssetstatus=''confirmed'',waitlist_order=null,membership_consumed=truewhereid=v_next.id;updatemembershipssetremaining_count=remaining_count-1whereid=v_next_mem.idandremaining_countisnotnull;' in ucs) > 0) as waitlist_promotion_consumed_ok,
        (position('remaining_countisnotnull' in cr) > 0 and position('remaining_countisnotnull' in ucs) > 0)                              as promotion_decrement_non_null_ok,
        -- 선행 조건: 예약 무결성 migration(수업명 정확 일치 + pass-only, LIKE 없음)이 적용된 is_membership_eligible_for_class를 재사용한다
        (position('r.class_title=c.title' in el) > 0 and position('pd.product_kind=''pass''' in el) > 0 and position('c.titlelike' in el) = 0) as eligibility_function_prereq_ok,
        -- helper: 존재 / SECURITY DEFINER / search_path 고정 / 내부 전용(PUBLIC·anon·authenticated 실행 불가)
        exists (select 1 from h)                                                                                                         as helper_exists_ok,
        coalesce((select prosecdef from h), false)                                                                                       as helper_security_definer_ok,
        coalesce((select cfg like '%search_path=public%' from h), false)                                                                 as helper_search_path_ok,
        coalesce((select not has_function_privilege('anon', oid, 'execute') and not has_function_privilege('authenticated', oid, 'execute')
                          and not has_function_privilege('public', oid, 'execute') from h), false)                                        as helper_internal_only_ok
    from d
)
select cks.*,
       case when grant_validates_schedule_ok and grant_kst_dates_ok and cancel_reservation_kst_ok and cancel_reservation_search_path_ok and goods_reservation_kst_ok and update_class_safe_kst_ok
                 and waitlist_promotion_status_ok and waitlist_promotion_unlimited_count_ok and waitlist_promotion_expiry_ok and waitlist_promotion_starts_ok
                 and waitlist_promotion_current_class_eligibility_ok and waitlist_promotion_consumed_ok and promotion_decrement_non_null_ok and eligibility_function_prereq_ok
                 and helper_exists_ok and helper_security_definer_ok and helper_search_path_ok and helper_internal_only_ok
            then 'APPLIED' else 'NOT_APPLIED' end as verdict
from cks;
