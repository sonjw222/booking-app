-- READ-ONLY(단일 SELECT): fix_member_candidate_search_rate_limit_20261004.sql 적용 상태 확인. 모든 *_ok가 true일 때만 verdict='APPLIED'(적용 전에는 NOT_APPLIED가 정상).
-- 함수 정의는 소문자/주석 제거/공백 제거/public. 제거로 정규화해 의미 단위를 검사한다.
with fn as (
    select p.oid, p.prosecdef, p.provolatile, p.proconfig::text as cfg
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'search_member_candidates'
       and pg_get_function_identity_arguments(p.oid) = 'p_center_id uuid, p_keyword text'
), body as (
    select replace(regexp_replace(regexp_replace(lower(pg_get_functiondef(oid)), '--[^\n\r]*', '', 'g'), '\s+', '', 'g'), 'public.', '') as n from fn
), t as (
    select c.oid, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = 'member_candidate_search_attempts' and c.relkind = 'r'
), c as (
    select
        exists (select 1 from t)                                                                                          as table_exists_ok,
        coalesce((select relrowsecurity from t), false)                                                                   as table_rls_enabled_ok,
        coalesce((select not has_table_privilege('anon', oid, 'select,insert,update,delete') from t), false)              as table_anon_denied_ok,
        coalesce((select not has_table_privilege('authenticated', oid, 'select,insert,update,delete') from t), false)     as table_authenticated_denied_ok,
        coalesce((select not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'member_candidate_search_attempts')), false) as table_no_policies_ok,
        exists (select 1 from fn)                                                                                         as function_exists_ok,
        coalesce((select prosecdef from fn), false)                                                                       as security_definer_ok,
        coalesce((select provolatile = 'v' from fn), false)                                                               as function_volatile_ok,
        coalesce((select cfg like '%search_path=public%' from fn), false)                                                 as search_path_pinned_ok,
        coalesce((select not has_function_privilege('anon', oid, 'execute') and not has_function_privilege('public', oid, 'execute') from fn), false) as anon_public_denied_ok,
        coalesce((select has_function_privilege('authenticated', oid, 'execute') from fn), false)                         as authenticated_allowed_ok,
        coalesce((select position('member_candidate_search_attempts' in n) > 0 and position('pg_advisory_xact_lock' in n) > 0 and position('v_recent>=30orv_daily>=200' in n) > 0 from body), false) as rate_limit_logic_ok,
        -- 권한 검사(create)가 rate limit(attempts 접근)보다 앞 → 권한 없는 호출은 한도 오류로 oracle이 되지 않음
        coalesce((select position('has_permission(p_center_id,''customer.member.create'')' in n) < position('member_candidate_search_attempts' in n) from body), false) as permission_before_rate_limit_ok
)
select c.*,
       (table_exists_ok and table_rls_enabled_ok and table_anon_denied_ok and table_authenticated_denied_ok and table_no_policies_ok
        and function_exists_ok and security_definer_ok and function_volatile_ok and search_path_pinned_ok and anon_public_denied_ok
        and authenticated_allowed_ok and rate_limit_logic_ok and permission_before_rate_limit_ok) as all_ok,
       case when (table_exists_ok and table_rls_enabled_ok and table_anon_denied_ok and table_authenticated_denied_ok and table_no_policies_ok
        and function_exists_ok and security_definer_ok and function_volatile_ok and search_path_pinned_ok and anon_public_denied_ok
        and authenticated_allowed_ok and rate_limit_logic_ok and permission_before_rate_limit_ok) then 'APPLIED' else 'NOT_APPLIED' end as verdict
from c;
