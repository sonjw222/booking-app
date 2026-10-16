-- 읽기 전용 검증 (적용 후 실행) — 모두 true여야 한다.
select
  (select pg_get_functiondef('public._refund_membership_core(uuid,uuid,boolean,boolean)'::regprocedure) like '%payment_provider is not null and o.payment_provider <> ''mock''%') as allowlist_guard_must_be_true,
  (select pg_get_functiondef('public._refund_membership_core(uuid,uuid,boolean,boolean)'::regprocedure) not like '%in (''toss'', ''portone'')%')            as old_denylist_gone_must_be_true,
  (select prosecdef from pg_proc where oid = 'public._refund_membership_core(uuid,uuid,boolean,boolean)'::regprocedure)                                    as security_definer_must_be_true,
  (select 'search_path=public' = any (proconfig) from pg_proc where oid = 'public._refund_membership_core(uuid,uuid,boolean,boolean)'::regprocedure)       as search_path_pinned_must_be_true,
  not has_function_privilege('authenticated', 'public._refund_membership_core(uuid,uuid,boolean,boolean)', 'execute')                                        as helper_not_callable_by_authenticated_must_be_true,
  not has_function_privilege('service_role',  'public._refund_membership_core(uuid,uuid,boolean,boolean)', 'execute')                                        as helper_not_callable_by_service_role_must_be_true;
