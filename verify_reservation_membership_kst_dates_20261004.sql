-- READ-ONLY 진단(단일 SELECT): public 스키마의 "라이브" 함수 정의 중 DB timezone(UTC) 의존 날짜(current_date, now()::date, current_timestamp::date, localtimestamp)를 쓰는 함수를 찾는다.
-- 배경(2026-10-04 저장소 전수 조사): 수강권 유효성 판정에 쓰이는 함수(reserve_class / reserve_with_membership / reserve_with_goods / usable_memberships(_for_classes) / cancel_reservation(대기 승격) /
--   update_class_safe(정원 확대 승격) / manager_grant_product / _issue_membership_and_record_payment / fulfill_order / _refund_membership_core / notify_expiring_passes)의 최종 정의는
--   이미 (now() at time zone 'Asia/Seoul')::date 를 쓴다(fix_reservation_integrity_20261003, fix_grant_schedule_and_kst_dates_20261003, fix_pg_order_refund_kst_dates_20261004 등).
--   그래서 이번에는 추가 migration/rollback을 만들지 않고, 이 진단으로 Production의 실제 라이브 정의에 남은 것이 없는지만 확인한다.
-- 예상 결과: evaluate_notification_rules 하나만 남는다 — pg_cron이 UTC 00:00(=KST 09:00)에 실행하므로 current_date와 KST 날짜가 일치해 의도적으로 유지(allowed_by_design).
--   그 외 함수가 나오면 verdict='REVIEW_NEEDED' 이고 unexpected 목록에 이름이 나온다(자동 수정 없음).
with live as (
    select p.proname,
           regexp_replace(lower(pg_get_functiondef(p.oid)), '--[^\n\r]*', '', 'g') as def
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.prokind = 'f'
), hits as (
    select proname from live
     where def ~ 'current_date' or def ~ 'now\(\)\s*::\s*date' or def ~ 'current_timestamp\s*::\s*date' or def ~ 'localtimestamp'
), c as (
    select
        coalesce((select array_agg(proname order by proname) from hits), '{}'::text[])                                                            as functions_using_utc_date,
        coalesce((select array_agg(proname order by proname) from hits where proname <> 'evaluate_notification_rules'), '{}'::text[])             as unexpected_functions
)
select c.*,
       case when cardinality(unexpected_functions) = 0 then 'CLEAN' else 'REVIEW_NEEDED' end as verdict
from c;
