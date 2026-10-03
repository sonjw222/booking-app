-- READ-ONLY(단일 SELECT): reservations 권한 최소화 + 유지해야 할 권한 확인. 모든 *_ok가 true일 때만 verdict='APPLIED'(적용 전에는 NOT_APPLIED가 정상).
with c as (
    select
        -- 회수 대상
        not has_table_privilege('authenticated', 'public.reservations', 'INSERT')       as auth_no_insert_ok,
        not has_table_privilege('authenticated', 'public.reservations', 'REFERENCES')   as auth_no_references_ok,
        not has_table_privilege('authenticated', 'public.reservations', 'TRIGGER')      as auth_no_trigger_ok,
        not has_table_privilege('anon', 'public.reservations', 'REFERENCES')            as anon_no_references_ok,
        not has_table_privilege('anon', 'public.reservations', 'TRIGGER')               as anon_no_trigger_ok,
        -- 이전 migration(예약 무결성)의 결과가 유지되는지
        not has_table_privilege('authenticated', 'public.reservations', 'UPDATE')       as auth_no_table_update_ok,
        has_column_privilege('authenticated', 'public.reservations', 'member_memo', 'UPDATE') as auth_memo_update_ok,
        not has_table_privilege('authenticated', 'public.reservations', 'TRUNCATE')     as auth_no_truncate_ok,
        not (has_table_privilege('anon', 'public.reservations', 'INSERT') or has_table_privilege('anon', 'public.reservations', 'UPDATE')
             or has_table_privilege('anon', 'public.reservations', 'DELETE') or has_table_privilege('anon', 'public.reservations', 'TRUNCATE')) as anon_no_write_ok,
        -- 유지해야 하는 권한: 앱 조회, 매니저 정리 정책, service_role 전체
        has_table_privilege('authenticated', 'public.reservations', 'SELECT')           as auth_select_kept_ok,
        has_table_privilege('authenticated', 'public.reservations', 'DELETE')           as auth_delete_kept_ok,
        has_table_privilege('service_role', 'public.reservations', 'SELECT')            as service_select_kept_ok,
        has_table_privilege('service_role', 'public.reservations', 'INSERT')            as service_insert_kept_ok,
        has_table_privilege('service_role', 'public.reservations', 'UPDATE')            as service_update_kept_ok,
        has_table_privilege('service_role', 'public.reservations', 'DELETE')            as service_delete_kept_ok,
        -- RLS 정책 4개는 그대로
        ((select count(*) from pg_policy where polrelid = 'public.reservations'::regclass) = 4)   as rls_policies_unchanged_ok,
        (select relrowsecurity from pg_class where oid = 'public.reservations'::regclass)         as rls_enabled_ok
)
select c.*,
       case when auth_no_insert_ok and auth_no_references_ok and auth_no_trigger_ok and anon_no_references_ok and anon_no_trigger_ok and auth_no_table_update_ok
                 and auth_memo_update_ok and auth_no_truncate_ok and anon_no_write_ok and auth_select_kept_ok and auth_delete_kept_ok and service_select_kept_ok
                 and service_insert_kept_ok and service_update_kept_ok and service_delete_kept_ok and rls_policies_unchanged_ok and rls_enabled_ok
            then 'APPLIED' else 'NOT_APPLIED' end as verdict
from c;
