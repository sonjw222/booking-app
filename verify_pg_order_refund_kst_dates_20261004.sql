-- READ-ONLY(단일 SELECT): fix_pg_order_refund_kst_dates_20261004.sql 적용 상태 확인(적용 전/후 모두 안전). 모든 *_ok가 true일 때만 verdict='APPLIED'(적용 전에는 NOT_APPLIED가 정상, 이때 보안/보존 항목은 true여야 한다).
-- [formatting-safe] 함수 정의(pg_get_functiondef)는 소문자·-- 주석 제거·모든 공백 제거·'public.' 제거로 정규화한 뒤 position()으로 검사한다(정규화 문자열은 공백이 없으므로 패턴도 공백 없이 쓴다).
--   SECURITY DEFINER / search_path / 실행 권한은 pg_proc과 권한 함수로 직접 확인한다.
with raw(k, t) as (
    values
    ('iss', pg_get_functiondef('public._issue_membership_and_record_payment(public.orders,text,text)'::regprocedure)),
    ('ful', pg_get_functiondef('public.fulfill_order(uuid)'::regprocedure)),
    ('ref', pg_get_functiondef('public._refund_membership_core(uuid,uuid,boolean,boolean)'::regprocedure))
), nd as (
    select k, replace(regexp_replace(regexp_replace(lower(t), '--[^\n\r]*', '', 'g'), '\s+', '', 'g'), 'public.', '') as n from raw
), d as (
    select max(n) filter (where k = 'iss') as iss, max(n) filter (where k = 'ful') as ful, max(n) filter (where k = 'ref') as ref from nd
), fn as (
    select p.proname, p.prosecdef, p.proconfig::text as cfg, p.oid
      from pg_proc p
     where p.oid in ('public._issue_membership_and_record_payment(public.orders,text,text)'::regprocedure, 'public.fulfill_order(uuid)'::regprocedure,
                     'public._refund_membership_core(uuid,uuid,boolean,boolean)'::regprocedure)
), c as (
    select
        -- 날짜: DB current_date 판정 제거 + KST 오늘 / days형 만료는 KST 기준으로 (now()+N days) 계산
        (position('current_date' in iss) = 0 and position('v_starts:=(now()attimezone''asia/seoul'')::date' in iss) > 0
            and position('((now()+(coalesce(v_product.expiry_days,0)||''days'')::interval)attimezone''asia/seoul'')::date' in iss) > 0)   as issue_kst_starts_and_expiry_ok,
        (position('current_date' in ful) = 0 and position('v_starts:=(now()attimezone''asia/seoul'')::date' in ful) > 0
            and position('((now()+(coalesce(v_product.expiry_days,0)||''days'')::interval)attimezone''asia/seoul'')::date' in ful) > 0)   as fulfill_kst_starts_and_expiry_ok,
        (position('current_date' in ref) = 0 and position('m.expires_atisnullorm.expires_at>=(now()attimezone''asia/seoul'')::date' in ref) > 0) as refund_remaining_active_kst_ok,
        -- 보존: 날짜 외 동작이 그대로(기존 expiry 모드/금액 검증/쿠폰/포인트/자동예약/환불 정책/PG lock)
        (position('calc_rolling_month_dates(now(),v_product.rolling_month_cutoff_day)' in iss) > 0 and position('when''date''thenv_product.expiry_date' in iss) > 0
            and position('_order_expected_amount(p_order,true)' in iss) > 0 and position('member_can_purchase_product(' in iss) > 0
            and position('_order_auto_book(v_membership_id' in iss) > 0 and position('pg_transaction_id' in iss) > 0)                      as issue_behavior_preserved_ok,
        (position('calc_rolling_month_dates(now(),v_product.rolling_month_cutoff_day)' in ful) > 0 and position('when''date''thenv_product.expiry_date' in ful) > 0
            and position('_order_expected_amount(v_order,true)' in ful) > 0 and position('v_order.status=''cancelled''' in ful) > 0
            and position('ensure_center_member(' in ful) > 0 and position('_order_auto_book(v_membership_id' in ful) > 0 and position('direct_amount' in ful) > 0) as fulfill_behavior_preserved_ok,
        (position('_refund_block_reason(' in ref) > 0 and position('_restore_order_points(' in ref) > 0 and position('app.pg_refund_write' in ref) > 0
            and position('status=''refunded'',remaining_count=0' in ref) > 0 and position('status<>''dormant''' in ref) > 0
            and position('m.status=''active''' in ref) > 0 and position('(m.remaining_countisnullorm.remaining_count>0)' in ref) > 0) as refund_behavior_preserved_ok
    from d
), sec as (
    select
        (select count(*) = 3 from fn)                                                                                        as three_functions_exist_ok,
        (select coalesce(bool_and(prosecdef), false) from fn)                                                                 as all_security_definer_ok,
        -- proconfig가 NULL(고정 안 됨)이면 false로 센다(bool_and는 NULL을 무시하므로 coalesce 필수)
        (select coalesce(bool_and(coalesce(cfg like '%search_path=public%', false)), false) from fn)                                           as all_search_path_pinned_ok,
        -- 내부 helper 2개: owner 외 직접 실행 불가(PUBLIC/anon/authenticated/service_role)
        (select coalesce(bool_and(not has_function_privilege('anon', oid, 'execute') and not has_function_privilege('authenticated', oid, 'execute')
                                  and not has_function_privilege('public', oid, 'execute') and not has_function_privilege('service_role', oid, 'execute')), false)
           from fn where proname in ('_issue_membership_and_record_payment', '_refund_membership_core'))                       as internal_helpers_not_executable_ok,
        -- fulfill_order: authenticated만 실행 가능(anon/PUBLIC/service_role 불가) — 기존 계약
        (select coalesce(bool_and(has_function_privilege('authenticated', oid, 'execute') and not has_function_privilege('anon', oid, 'execute')
                                  and not has_function_privilege('public', oid, 'execute') and not has_function_privilege('service_role', oid, 'execute')), false)
           from fn where proname = 'fulfill_order')                                                                           as fulfill_order_execute_contract_ok
)
select c.*, sec.*,
       -- 정보용(verdict 미포함): 아직 current_date를 쓰는 public 함수(이번 범위 밖 — 알림 cron 함수 evaluate_notification_rules만 남는 것이 정상)
       (select coalesce(string_agg(p.proname, ',' order by p.proname), '') from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prosrc ~* 'current_date|current_timestamp|localtimestamp') as info_remaining_current_date_functions,
       case when c.issue_kst_starts_and_expiry_ok and c.fulfill_kst_starts_and_expiry_ok and c.refund_remaining_active_kst_ok
                 and c.issue_behavior_preserved_ok and c.fulfill_behavior_preserved_ok and c.refund_behavior_preserved_ok
                 and sec.three_functions_exist_ok and sec.all_security_definer_ok and sec.all_search_path_pinned_ok
                 and sec.internal_helpers_not_executable_ok and sec.fulfill_order_execute_contract_ok
            then 'APPLIED' else 'NOT_APPLIED' end as verdict
from c cross join sec;
