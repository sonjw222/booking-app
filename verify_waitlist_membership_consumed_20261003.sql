-- READ-ONLY(단일 SELECT): fix_waitlist_membership_consumed_20261003.sql + 승격 경로(fix_grant_schedule_and_kst_dates_20261003.sql)의 consumed 일관성 확인.
-- 모든 *_ok가 true일 때만 verdict='APPLIED'(적용 전에는 NOT_APPLIED가 정상).
with f as (
    select
        pg_get_functiondef('public.reserve_class(uuid,uuid)'::regprocedure)        as rc,
        pg_get_functiondef('public.reserve_with_membership(uuid,uuid,uuid)'::regprocedure) as rwm,
        pg_get_functiondef('public.cancel_reservation(uuid)'::regprocedure)        as cr,
        (select pg_get_functiondef(p.oid) from pg_proc p where p.proname = 'update_class_safe' and p.pronamespace = 'public'::regnamespace limit 1) as ucs
), c as (
    select
        (rc like '%values (p_class_id, v_profile_id, v_membership.id, ''confirmed'', true)%')                                                       as reserve_class_confirmed_consumed_true_ok,
        (rc like '%values (p_class_id, v_profile_id, v_membership.id, ''waitlisted'', v_wait_order, false)%')                                         as reserve_class_waitlisted_consumed_false_ok,
        -- 예약 무결성 SQL의 핵심 조건이 유지되는지(이 정의가 그 위에 있다)
        (rc like '%and m.status = ''active''%' and rc !~ 'current_date')                                                                             as reserve_class_integrity_kept_ok,
        -- reserve_with_membership: 대기=false, 확정=true (기존 동작 유지)
        (rwm like '%''MEMBER'', ''USER'', my_account_id(), false%' and rwm like '%''MEMBER'', ''USER'', my_account_id(), true%')                    as reserve_with_membership_consumed_ok,
        -- 두 승격 경로: confirmed로 바꿀 때 membership_consumed = true도 함께
        (cr like '%set status = ''confirmed'', waitlist_order = null, membership_consumed = true%')                                                  as cancel_reservation_promotion_consumed_ok,
        (ucs like '%set status = ''confirmed'', waitlist_order = null, membership_consumed = true%')                                                 as update_class_safe_promotion_consumed_ok,
        -- 차감과 같은 성공 경로(무제한 NULL은 그대로)
        (cr like '%where id = v_next_mem.id and remaining_count is not null%' and ucs like '%where id = v_next_mem.id and remaining_count is not null%') as promotion_decrement_same_path_ok
    from f
)
select c.*,
       case when reserve_class_confirmed_consumed_true_ok and reserve_class_waitlisted_consumed_false_ok and reserve_class_integrity_kept_ok and reserve_with_membership_consumed_ok
                 and cancel_reservation_promotion_consumed_ok and update_class_safe_promotion_consumed_ok and promotion_decrement_same_path_ok
            then 'APPLIED' else 'NOT_APPLIED' end as verdict
from c;
