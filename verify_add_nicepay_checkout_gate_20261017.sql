-- 읽기 전용 검증 (적용 후) — 모두 true 여야 한다. (mode 값은 정보용: 활성화 전에는 off 여야 정상)
select
  to_regprocedure('public.nicepay_checkout_mode()') is not null                                                                          as gate_function_present_must_be_true,
  exists (select 1 from pg_trigger where tgname = 'orders_guard_nicepay_create' and tgrelid = 'public.orders'::regclass and not tgisinternal) as orders_trigger_present_must_be_true,
  (select relrowsecurity from pg_class where oid = 'public.nicepay_checkout_gate'::regclass)
    and (select relrowsecurity from pg_class where oid = 'public.nicepay_checkout_gate_audit'::regclass)                                     as rls_on_must_be_true,
  not has_table_privilege('anon', 'public.nicepay_checkout_gate', 'select') and not has_table_privilege('authenticated', 'public.nicepay_checkout_gate', 'select')
    and not has_table_privilege('authenticated', 'public.nicepay_checkout_gate', 'update') and not has_table_privilege('service_role', 'public.nicepay_checkout_gate', 'update')
    and not has_table_privilege('anon', 'public.nicepay_checkout_gate_audit', 'select') and not has_table_privilege('authenticated', 'public.nicepay_checkout_gate_audit', 'insert') as client_roles_no_table_access_must_be_true,
  not has_function_privilege('anon', 'public.nicepay_checkout_mode()', 'execute') and not has_function_privilege('authenticated', 'public.nicepay_checkout_mode()', 'execute')
    and not has_function_privilege('authenticated', 'public.orders_guard_nicepay_create()', 'execute')                                       as client_roles_no_function_access_must_be_true,
  (select bool_and(prosecdef and 'search_path=public' = any (proconfig)) from pg_proc where proname in ('nicepay_checkout_mode', 'orders_guard_nicepay_create', 'nicepay_checkout_gate_audit_fn', 'nicepay_checkout_gate_immutable_fn') and pronamespace = 'public'::regnamespace) as secdef_pinned_must_be_true,
  (select count(*) = 1 from nicepay_checkout_gate)                                                                                         as single_gate_row_must_be_true,
  (select mode = 'off' from nicepay_checkout_gate)                                                                                         as info_gate_mode_off_before_activation;
