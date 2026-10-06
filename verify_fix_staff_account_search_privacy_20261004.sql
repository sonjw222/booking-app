-- READ-ONLY(단일 SELECT): fix_staff_account_search_privacy_20261004.sql 적용 상태 확인. 모든 *_ok가 true일 때만 verdict='APPLIED'(적용 전에는 NOT_APPLIED가 정상, 이때 relation_*_kept_ok 항목은 true여야 한다).
-- [formatting-safe] 정책/함수 정의는 소문자·-- 주석 제거·모든 공백 제거·'public.' 제거로 정규화한 뒤 position()으로 검사한다(정규화 문자열은 공백이 없으므로 패턴도 공백 없이 쓴다).
with fn as (
    select p.oid, p.prosecdef, p.proconfig::text as cfg
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'search_staff_candidates' and pg_get_function_identity_arguments(p.oid) = 'p_center_id uuid, p_phone text'
), body as (
    select replace(regexp_replace(regexp_replace(lower(pg_get_functiondef(oid)), '--[^\n\r]*', '', 'g'), '\s+', '', 'g'), 'public.', '') as n from fn
), pol as (
    select count(*) as cnt,
           max(replace(regexp_replace(lower(pg_get_expr(polqual, polrelid)), '\s+', '', 'g'), 'public.', '')) as q,
           bool_and(polcmd = 'r') as all_select
      from pg_policy where polrelid = 'public.accounts'::regclass and polname = '계정 조회'
), selpol as (
    -- accounts의 SELECT를 허용하는 모든 permissive 정책(polcmd 'r' = SELECT, '*' = ALL). 다른 정책이 하나라도 추가되면 광범위 노출을 놓치지 않도록 정확히 1개("계정 조회")만 허용한다.
    select count(*) as cnt, bool_and(polname = '계정 조회') as only_expected_name
      from pg_policy where polrelid = 'public.accounts'::regclass and polcmd in ('r', '*') and polpermissive
), t as (
    select c.oid, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = 'staff_candidate_search_attempts' and c.relkind = 'r'
), c as (
    select
        -- 시도 기록 테이블: 존재 / RLS / 정책 없음 / anon·authenticated 권한 없음(client 직접 접근 불가)
        exists (select 1 from t)                                                                                            as attempts_table_exists_ok,
        coalesce((select relrowsecurity from t), false)                                                                     as attempts_table_rls_ok,
        coalesce((select not has_table_privilege('anon', oid, 'select,insert,update,delete') and not has_table_privilege('authenticated', oid, 'select,insert,update,delete') from t), false) as attempts_table_locked_ok,
        coalesce((select not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'staff_candidate_search_attempts')), false) as attempts_table_no_policies_ok,
        -- rate limit: VOLATILE + advisory lock + 한도 + 권한 확인이 시도 기록보다 먼저
        coalesce((select p.provolatile = 'v' from pg_proc p where p.oid = (select oid from fn)), false)                     as rpc_volatile_ok,
        coalesce((select position('pg_advisory_xact_lock' in n) > 0 and position('v_recent>=30orv_daily>=200' in n) > 0 and position('staff_candidate_search_attempts' in n) > 0 from body), false) as rpc_rate_limit_logic_ok,
        coalesce((select position('has_permission(p_center_id,''facility.staff.create'')' in n) < position('staff_candidate_search_attempts' in n) from body), false) as rpc_permission_before_rate_limit_ok,
        -- 중복 활성 계정(데이터 이상)은 exception이 아니라 return(0건): exception은 같은 트랜잭션의 시도 기록 INSERT를 롤백하고 중복 존재를 외부에 알린다
        coalesce((select position('array_length(v_ids,1)>1thenreturn;' in n) > 0 and position('raiseexception''같은번호' in n) = 0 and position('여러개' in n) = 0 from body), false) as rpc_duplicate_returns_empty_ok,
        -- RPC: 존재 / SECURITY DEFINER / search_path 고정 / anon·PUBLIC 실행 불가 / authenticated 실행 가능
        exists (select 1 from fn)                                                                                           as rpc_exists_ok,
        coalesce((select prosecdef from fn), false)                                                                         as rpc_security_definer_ok,
        coalesce((select cfg like '%search_path=public%' from fn), false)                                                   as rpc_search_path_pinned_ok,
        coalesce((select not has_function_privilege('anon', oid, 'execute') from fn), false)                                as rpc_anon_denied_ok,
        coalesce((select not has_function_privilege('public', oid, 'execute') from fn), false)                              as rpc_public_denied_ok,
        coalesce((select has_function_privilege('authenticated', oid, 'execute') from fn), false)                           as rpc_authenticated_allowed_ok,
        -- RPC 본문: 로그인 필수 + 요청 센터에 대한 staff.create 권한 + 정규화 정확 일치 + 병합/비활성 제외 + 마스킹 + 부분검색(ilike/like) 없음
        coalesce((select position('auth.uid()isnull' in n) > 0 and position('has_permission(p_center_id,''facility.staff.create'')' in n) > 0
                         and position('kr_phone_digits(a.phone)=v_digits' in n) > 0 and position('a.merged_intoisnull' in n) > 0 and position('a.deactivated_atisnull' in n) > 0
                         and position('left(v_digits,3)||''-****-''||right(v_digits,4)' in n) > 0 and position('ilike' in n) = 0 and position('like''%' in n) = 0 from body), false) as rpc_body_contract_ok,
        coalesce((select position('has_permission(p_center_id,''facility.staff.create'')' in n) < position('returnquery' in n) from body), false) as rpc_permission_before_read_ok,
        -- accounts SELECT 허용 정책 전체: 정확히 1개이고 이름이 "계정 조회"(다른 permissive SELECT/ALL 정책이 추가되면 NOT_APPLIED)
        coalesce((select cnt = 1 and only_expected_name from selpol), false)                                                as accounts_select_policies_exact_ok,
        -- accounts "계정 조회": 정책 1개(select), 전역 owner/staff.create 절 제거
        coalesce((select cnt = 1 and all_select from pol), false)                                                           as policy_single_select_ok,
        coalesce((select position('facility.staff.create' in q) = 0 and position('is_owner' in q) = 0 and position('role_permissions' in q) = 0 and position('center_roles' in q) = 0 from pol), false) as policy_global_staff_clause_removed_ok,
        -- 관계 기반 조회는 유지(본인 / 계정 연동 / 내 센터 스태프 / 내 센터 회원)
        coalesce((select position('auth_id=auth.uid()' in q) > 0 and position('account_auth_identities' in q) > 0 from pol), false)           as relation_self_and_linked_kept_ok,
        coalesce((select position('frommanager_centersmcwhere' in q) > 0 and position('my_managed_center_ids()' in q) > 0 from pol), false)  as relation_managed_staff_kept_ok,
        coalesce((select position('joincenter_membersc' in q) > 0 or position('center_memberscm' in q) > 0 from pol), false)                  as relation_managed_members_kept_ok,
        -- 선행 조건: 정규화 helper(kr_phone_digits) 존재
        exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'kr_phone_digits') as kr_phone_digits_prereq_ok
)
select c.*,
       case when rpc_duplicate_returns_empty_ok and attempts_table_exists_ok and attempts_table_rls_ok and attempts_table_locked_ok and attempts_table_no_policies_ok and rpc_volatile_ok and rpc_rate_limit_logic_ok and rpc_permission_before_rate_limit_ok
                 and rpc_exists_ok and rpc_security_definer_ok and rpc_search_path_pinned_ok and rpc_anon_denied_ok and rpc_public_denied_ok and rpc_authenticated_allowed_ok
                 and rpc_body_contract_ok and rpc_permission_before_read_ok and accounts_select_policies_exact_ok and policy_single_select_ok and policy_global_staff_clause_removed_ok
                 and relation_self_and_linked_kept_ok and relation_managed_staff_kept_ok and relation_managed_members_kept_ok and kr_phone_digits_prereq_ok
            then 'APPLIED' else 'NOT_APPLIED' end as verdict
from c;
