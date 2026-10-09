-- READ-ONLY 확인(SELECT만) — add_admin_list_centers_rpc_20261009.sql 적용 후 한 문장씩 실행.
-- 1) 함수 속성: security_definer=true, config에 search_path= (빈 값)
select p.proname, p.prosecdef as security_definer, p.proconfig as config, p.provolatile
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'admin_list_centers';

-- 2) 소유자가 RLS 우회 역할인지(rolbypassrls=true 여야 centers RLS와 무관하게 읽는다 — Supabase 기본 postgres)
select p.proname, r.rolname as owner, r.rolbypassrls, r.rolsuper
from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_roles r on r.oid = p.proowner
where n.nspname = 'public' and p.proname = 'admin_list_centers';

-- 3) EXECUTE 권한: anon=false, authenticated=true, service_role=기본값(참고)
select has_function_privilege('anon', p.oid, 'execute') as anon_exec,
       has_function_privilege('authenticated', p.oid, 'execute') as authenticated_exec,
       has_function_privilege('service_role', p.oid, 'execute') as service_role_exec,
       (select count(*) from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0) as public_grants
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'admin_list_centers';
-- 기대: anon_exec=false, authenticated_exec=true, public_grants=0
-- 4) 기능 확인은 SQL Editor가 아니라 앱(관리자 로그인)에서: /admin/centers 에서 대기/승인/반려 탭이 보이는지.
--    일반 회원 로그인으로 같은 RPC 호출이 'forbidden'(42501)으로 거부되는지는 앱/테스트에서 확인.
