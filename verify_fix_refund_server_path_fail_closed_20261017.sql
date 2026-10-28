-- 읽기 전용 검증 (적용 후) — 모두 true 여야 한다.
select
  (select d like '%-- pg_server_path_guard begin%' and d like '%-- pg_server_path_guard end%' from (select pg_get_functiondef('public._refund_membership_core(uuid,uuid,boolean,boolean)'::regprocedure) d) x) as server_path_guard_present_must_be_true,
  (select d like '%-- pg_unknown_origin_guard begin%' from (select pg_get_functiondef('public._refund_membership_core(uuid,uuid,boolean,boolean)'::regprocedure) d) x)                                          as prior_origin_guard_still_present_must_be_true,
  (select d like '%-- pg_origin_context begin%' and d like '%unknown_pg%' from (select pg_get_functiondef('public.pg_refund_context(uuid,uuid)'::regprocedure) d) x)                                          as context_patch_present_must_be_true,
  (select prosecdef and 'search_path=public' = any (proconfig) from pg_proc where oid = 'public.pg_refund_context(uuid,uuid)'::regprocedure)                                                                      as context_secdef_pinned_must_be_true,
  (select prosecdef and 'search_path=public' = any (proconfig) from pg_proc where oid = 'public._refund_membership_core(uuid,uuid,boolean,boolean)'::regprocedure)                                               as core_secdef_pinned_must_be_true,
  has_function_privilege('service_role', 'public.pg_refund_context(uuid,uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public.pg_refund_context(uuid,uuid)', 'execute')
    and not has_function_privilege('anon', 'public.pg_refund_context(uuid,uuid)', 'execute')                                                                                                                      as context_service_role_only_must_be_true,
  not has_function_privilege('authenticated', 'public._refund_membership_core(uuid,uuid,boolean,boolean)', 'execute')
    and not has_function_privilege('service_role', 'public._refund_membership_core(uuid,uuid,boolean,boolean)', 'execute')                                                                                       as core_not_directly_callable_must_be_true;
