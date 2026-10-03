-- READ-ONLY(단일 SELECT): fix_waitlist_membership_consumed_20261003.sql + 승격 경로(fix_grant_schedule_and_kst_dates_20261003.sql)의 membership_consumed 일관성 확인.
-- 모든 *_ok가 true일 때만 verdict='APPLIED'(적용 전에는 NOT_APPLIED가 정상).
-- [formatting-safe] 함수 정의(pg_get_functiondef)는 SQL Editor가 CRLF/들여쓰기/공백을 바꿔 저장할 수 있다. 그래서 정의를 (1) 소문자로, (2) -- 주석 제거, (3) 모든 공백 제거, (4) 'public.' 접두사 제거로 정규화한 뒤
--   position()으로 "의미 단위"(컬럼/값 순서가 있는 INSERT, 같은 UPDATE 안의 status/waitlist_order/membership_consumed, 차감 조건)를 검사한다. 정규화 문자열은 공백이 없으므로 패턴도 공백 없이 쓴다.
with raw(k, t) as (
    values
    ('rc',  pg_get_functiondef('public.reserve_class(uuid,uuid)'::regprocedure)),
    ('rwm', pg_get_functiondef('public.reserve_with_membership(uuid,uuid,uuid)'::regprocedure)),
    ('cr',  pg_get_functiondef('public.cancel_reservation(uuid)'::regprocedure)),
    ('ucs', (select pg_get_functiondef(p.oid) from pg_proc p where p.proname = 'update_class_safe' and p.pronamespace = 'public'::regnamespace limit 1))
), nd as (
    select k, replace(regexp_replace(regexp_replace(lower(t), '--[^\n\r]*', '', 'g'), '\s+', '', 'g'), 'public.', '') as n from raw
), d as (
    select max(n) filter (where k = 'rc') as rc, max(n) filter (where k = 'rwm') as rwm, max(n) filter (where k = 'cr') as cr, max(n) filter (where k = 'ucs') as ucs from nd
), c as (
    select
        -- reserve_class: 확정 insert = consumed true, 대기 insert = consumed false(컬럼 기본값 true에 의존하지 않는다)
        (position('insertintoreservations(class_id,profile_id,membership_id,status,membership_consumed)values(p_class_id,v_profile_id,v_membership.id,''confirmed'',true)' in rc) > 0) as reserve_class_confirmed_consumed_true_ok,
        (position('insertintoreservations(class_id,profile_id,membership_id,status,waitlist_order,membership_consumed)values(p_class_id,v_profile_id,v_membership.id,''waitlisted'',v_wait_order,false)' in rc) > 0) as reserve_class_waitlisted_consumed_false_ok,
        -- 예약 무결성 SQL의 핵심이 유지되는지: active 상태 직접 강제 + DB current_date 미사용 + KST 날짜
        (position('m.status=''active''' in rc) > 0 and position('current_date' in rc) = 0 and position('(now()attimezone''asia/seoul'')::date' in rc) > 0) as reserve_class_integrity_kept_ok,
        -- reserve_with_membership: 대기 insert false, 확정 insert true (reservation_type/source/created_by 뒤의 membership_consumed 값)
        (position('''member'',''user'',my_account_id(),false' in rwm) > 0 and position('''member'',''user'',my_account_id(),true' in rwm) > 0) as reserve_with_membership_consumed_ok,
        -- 승격 두 경로(cancel_reservation / update_class_safe): 같은 성공 경로(if found)에서 status/waitlist_order/membership_consumed 갱신 후 remaining_count가 NULL이 아닐 때만 차감
        (position('status=''confirmed''' in cr) > 0 and position('waitlist_order=null' in cr) > 0 and position('membership_consumed=true' in cr) > 0
            and position('iffoundthenupdatereservationssetstatus=''confirmed'',waitlist_order=null,membership_consumed=truewhereid=v_next.id;updatemembershipssetremaining_count=remaining_count-1whereid=v_next_mem.idandremaining_countisnotnull;' in cr) > 0) as cancel_reservation_promotion_consumed_ok,
        (position('status=''confirmed''' in ucs) > 0 and position('waitlist_order=null' in ucs) > 0 and position('membership_consumed=true' in ucs) > 0
            and position('iffoundthenupdatereservationssetstatus=''confirmed'',waitlist_order=null,membership_consumed=truewhereid=v_next.id;updatemembershipssetremaining_count=remaining_count-1whereid=v_next_mem.idandremaining_countisnotnull;' in ucs) > 0) as update_class_safe_promotion_consumed_ok,
        (position('remaining_countisnotnull' in cr) > 0 and position('remaining_countisnotnull' in ucs) > 0) as promotion_decrement_non_null_ok
    from d
)
select c.*,
       case when reserve_class_confirmed_consumed_true_ok and reserve_class_waitlisted_consumed_false_ok and reserve_class_integrity_kept_ok and reserve_with_membership_consumed_ok
                 and cancel_reservation_promotion_consumed_ok and update_class_safe_promotion_consumed_ok and promotion_decrement_non_null_ok
            then 'APPLIED' else 'NOT_APPLIED' end as verdict
from c;
