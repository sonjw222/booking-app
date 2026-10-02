-- READ-ONLY(단일 SELECT): add_member_candidate_search_20261003.sql 적용 상태 확인. 모든 *_ok가 true일 때만 verdict='APPLIED'.
with fn as (
    select p.oid, p.prosecdef, p.proconfig::text as cfg
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'search_member_candidates'
       and pg_get_function_identity_arguments(p.oid) = 'p_center_id uuid, p_keyword text'
), old as (
    select to_regprocedure('public.search_accounts_for_member(text)') as oid
), c as (
    select
        exists (select 1 from fn)                                                                                   as function_exists_ok,
        coalesce((select prosecdef from fn), false)                                                                 as security_definer_ok,
        coalesce((select cfg like '%search_path=public%' from fn), false)                                           as search_path_pinned_ok,
        coalesce((select not has_function_privilege('anon', oid, 'execute') from fn), false)                        as anon_denied_ok,
        coalesce((select not has_function_privilege('public', oid, 'execute') from fn), false)                      as public_denied_ok,
        coalesce((select has_function_privilege('authenticated', oid, 'execute') from fn), false)                   as authenticated_allowed_ok,
        -- 전역 부분일치 RPC는 authenticated도 실행 불가(함수가 없으면 이 항목은 true)
        coalesce((select not has_function_privilege('authenticated', oid, 'execute') from old where oid is not null), true) as old_global_search_revoked_ok,
        coalesce((select not has_function_privilege('anon', oid, 'execute') from old where oid is not null), true)         as old_global_search_anon_denied_ok,
        -- 본문에 전역 LIKE/ilike 부분일치가 없고 권한 검사/정확 일치가 있다
        coalesce((select pg_get_functiondef(oid) !~* 'ilike' and pg_get_functiondef(oid) like '%has_permission(p_center_id, ''customer.member.create'')%' and pg_get_functiondef(oid) like '%= v_exact%' from fn), false) as body_guard_ok
)
select c.*,
       case when function_exists_ok and security_definer_ok and search_path_pinned_ok and anon_denied_ok and public_denied_ok and authenticated_allowed_ok
                 and old_global_search_revoked_ok and old_global_search_anon_denied_ok and body_guard_ok
            then 'APPLIED' else 'NOT_APPLIED' end as verdict
from c;
