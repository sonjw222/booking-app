-- READ-ONLY 확인(SELECT만) — 적용 후 실행. 기대: anon_exec=false, authenticated_exec=false, service_role_exec=true
select p.oid::regprocedure as function,
       has_function_privilege('anon', p.oid, 'execute')          as anon_exec,
       has_function_privilege('authenticated', p.oid, 'execute') as authenticated_exec,
       has_function_privilege('service_role', p.oid, 'execute')  as service_role_exec,
       p.prosecdef as security_definer
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'ensure_center_member';
