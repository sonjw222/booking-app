-- READ-ONLY(단일 SELECT): reservations 권한 최종 상태 확인(fix_reservation_integrity_20261003 + fix_reservations_privileges_minimize_20261003 + 이번 fix 모두 적용된 상태).
-- 모든 *_ok가 true일 때만 verdict='APPLIED'. prerequisite_* 가 false면 선행 migration이 아직 적용되지 않은 것이다.
with c as (
    select
        -- 이번 migration
        not has_table_privilege('authenticated', 'public.reservations', 'DELETE')       as auth_no_delete_ok,
        not has_table_privilege('anon', 'public.reservations', 'SELECT')                as anon_no_select_ok,
        -- 선행 migration(예약 무결성 + 권한 최소화) 결과가 유지되는지
        not has_table_privilege('authenticated', 'public.reservations', 'INSERT')       as prerequisite_auth_no_insert_ok,
        not has_table_privilege('authenticated', 'public.reservations', 'UPDATE')       as prerequisite_auth_no_table_update_ok,
        not has_table_privilege('authenticated', 'public.reservations', 'TRUNCATE')     as prerequisite_auth_no_truncate_ok,
        not has_table_privilege('authenticated', 'public.reservations', 'REFERENCES')   as prerequisite_auth_no_references_ok,
        not has_table_privilege('authenticated', 'public.reservations', 'TRIGGER')      as prerequisite_auth_no_trigger_ok,
        not (has_table_privilege('anon', 'public.reservations', 'INSERT') or has_table_privilege('anon', 'public.reservations', 'UPDATE')
             or has_table_privilege('anon', 'public.reservations', 'DELETE') or has_table_privilege('anon', 'public.reservations', 'TRUNCATE')
             or has_table_privilege('anon', 'public.reservations', 'REFERENCES') or has_table_privilege('anon', 'public.reservations', 'TRIGGER')) as prerequisite_anon_no_other_ok,
        -- 유지해야 하는 권한
        has_column_privilege('authenticated', 'public.reservations', 'member_memo', 'UPDATE') as auth_memo_update_kept_ok,
        has_table_privilege('authenticated', 'public.reservations', 'SELECT')           as auth_select_kept_ok,
        has_table_privilege('service_role', 'public.reservations', 'SELECT')            as service_select_kept_ok,
        has_table_privilege('service_role', 'public.reservations', 'INSERT')            as service_insert_kept_ok,
        has_table_privilege('service_role', 'public.reservations', 'UPDATE')            as service_update_kept_ok,
        has_table_privilege('service_role', 'public.reservations', 'DELETE')            as service_delete_kept_ok,
        -- RLS 켜짐 + 핵심 정책 존재(정책은 지우지 않는다)
        (select relrowsecurity from pg_class where oid = 'public.reservations'::regclass) as rls_enabled_ok,
        exists (select 1 from pg_policy where polrelid = 'public.reservations'::regclass and polname = '본인 예약 메모 수정')     as memo_policy_ok,
        exists (select 1 from pg_policy where polrelid = 'public.reservations'::regclass and polname = '매니저 센터 예약 조회') as manager_select_policy_ok,
        exists (select 1 from pg_policy where polrelid = 'public.reservations'::regclass and polname = '매니저 취소예약 정리')   as manager_cleanup_policy_present_ok
)
select c.*,
       case when auth_no_delete_ok and anon_no_select_ok and prerequisite_auth_no_insert_ok and prerequisite_auth_no_table_update_ok
                 and prerequisite_auth_no_truncate_ok and prerequisite_auth_no_references_ok and prerequisite_auth_no_trigger_ok and prerequisite_anon_no_other_ok
                 and auth_memo_update_kept_ok and auth_select_kept_ok and service_select_kept_ok and service_insert_kept_ok and service_update_kept_ok and service_delete_kept_ok
                 and rls_enabled_ok and memo_policy_ok and manager_select_policy_ok and manager_cleanup_policy_present_ok
            then 'APPLIED' else 'NOT_APPLIED' end as verdict
from c;
