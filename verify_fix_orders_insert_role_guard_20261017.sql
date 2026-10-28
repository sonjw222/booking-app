-- 읽기 전용 검증 (적용 후) — 모두 true 여야 한다.
select
  (select d like '%/*insert_role_guard*/%' and d like '%''anon'', ''authenticated''%' from (select pg_get_functiondef('public.orders_force_server_fields_on_insert()'::regprocedure) d) x) as role_guard_present_must_be_true,
  (select prosecdef and 'search_path=public' = any (proconfig) from pg_proc where oid = 'public.orders_force_server_fields_on_insert()'::regprocedure)                                    as secdef_search_path_pinned_must_be_true,
  not has_function_privilege('anon', 'public.orders_force_server_fields_on_insert()', 'execute')
    and not has_function_privilege('authenticated', 'public.orders_force_server_fields_on_insert()', 'execute')                                                                       as not_client_callable_must_be_true,
  exists (select 1 from pg_trigger t where t.tgrelid = 'public.orders'::regclass and t.tgname = 'orders_force_server_fields_on_insert' and t.tgenabled <> 'D' and not t.tgisinternal)   as trigger_enabled_must_be_true,
  (select relrowsecurity from pg_class where oid = 'public.orders'::regclass)                                                                                                         as orders_rls_enabled_must_be_true;
