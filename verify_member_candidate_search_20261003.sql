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
        coalesce((select pg_get_functiondef(oid) !~* 'ilike' and pg_get_functiondef(oid) like '%has_permission(p_center_id, ''customer.member.create'')%' and pg_get_functiondef(oid) like '%= v_exact%' from fn), false) as body_guard_ok,
        -- 전화번호 권한 분리: 기존 센터 회원의 전화 부분검색/전체 번호는 customer.member.phone(또는 platform admin)일 때만(fetch_member_phones_safe와 같은 기준)
        coalesce((select pg_get_functiondef(oid) like '%has_permission(p_center_id, ''customer.member.phone'')%' and pg_get_functiondef(oid) like '%is_platform_admin()%'
                         and pg_get_functiondef(oid) like '%case when v_can_phone then a.phone else null end%'
                         and pg_get_functiondef(oid) like '%v_can_phone and length(v_digits) >= 2%' from fn), false) as phone_permission_gate_ok,
        -- 입력/저장 전화번호 정규화 helper(내부 전용) + 정규화 비교 사용
        coalesce((select pg_get_functiondef(oid) like '%public.kr_phone_digits(a.phone) = v_exact%' from fn), false) as phone_canonical_compare_ok,
        exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'kr_phone_digits'
                  and not has_function_privilege('anon', p.oid, 'execute') and not has_function_privilege('authenticated', p.oid, 'execute') and not has_function_privilege('public', p.oid, 'execute')) as canonical_helper_internal_ok,
        -- 마스킹: 센터 밖 결과는 전체 번호를 반환하지 않는다
        coalesce((select pg_get_functiondef(oid) like '%left(v_exact, 3) || ''-****-'' || right(v_exact, 4)%' from fn), false) as masked_exact_result_ok
)
select c.*,
       case when function_exists_ok and security_definer_ok and search_path_pinned_ok and anon_denied_ok and public_denied_ok and authenticated_allowed_ok
                 and old_global_search_revoked_ok and old_global_search_anon_denied_ok and body_guard_ok
                 and phone_permission_gate_ok and phone_canonical_compare_ok and canonical_helper_internal_ok and masked_exact_result_ok
            then 'APPLIED' else 'NOT_APPLIED' end as verdict
from c;
