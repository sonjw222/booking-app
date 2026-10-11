-- Read-only catalog verification. This does not measure production latency.
select p.oid::regprocedure as signature, p.prosecdef as security_definer,
       p.proconfig as settings, r.rolname as owner, r.rolsuper, r.rolbypassrls
from pg_proc p join pg_roles r on r.oid=p.proowner
where p.oid=to_regprocedure('public.admin_list_centers_page(text,text,integer,timestamptz,uuid)');
select has_function_privilege('anon','public.admin_list_centers_page(text,text,integer,timestamptz,uuid)','EXECUTE') as anon_execute,
       has_function_privilege('authenticated','public.admin_list_centers_page(text,text,integer,timestamptz,uuid)','EXECUTE') as authenticated_execute;
-- Expected: 1 row, security_definer=true, search_path=public, pg_temp,
-- owner postgres or approved BYPASSRLS owner; anon_execute=false, authenticated_execute=true.
-- Staging signed-in RPC verification: platform admin receives <=31 rows;
-- regular account returns 42501; anon permission denied; p_limit=101 returns 22023.
