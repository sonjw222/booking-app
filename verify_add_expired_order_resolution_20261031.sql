-- 읽기 전용 확인 — add_expired_order_resolution_20261031.sql 적용 후 실행(변경 없음). 기대값은 열 이름에 적혀 있다.
select
  md5(pg_get_functiondef('public.fulfill_order(uuid)'::regprocedure)) = '18c4bb13b1b1f812b6dbef882f0ce068'                                 as fulfill_order_patched_must_be_true,
  position('expired_order_guard begin' in pg_get_functiondef('public.fulfill_order(uuid)'::regprocedure)) > 0              as guard_present_must_be_true,
  position('fulfill_nicepay_guard begin' in pg_get_functiondef('public.fulfill_order(uuid)'::regprocedure)) > 0            as nicepay_guard_kept_must_be_true,
  to_regclass('public.order_expiry_resolutions') is not null                                                               as table_exists_must_be_true,
  (select relrowsecurity from pg_class where oid = 'public.order_expiry_resolutions'::regclass)                            as rls_on_must_be_true,
  (select count(*) from pg_policies where tablename = 'order_expiry_resolutions')                                          as policies_must_be_1,
  has_table_privilege('authenticated', 'public.order_expiry_resolutions', 'select')                                        as authenticated_can_select_must_be_true,
  not has_table_privilege('authenticated', 'public.order_expiry_resolutions', 'insert, update, delete')                    as authenticated_cannot_write_must_be_true,
  has_function_privilege('authenticated', 'public.manager_resolve_expired_order(uuid,text,text,integer,date,text,date,date)', 'execute') as rpc_executable_by_authenticated_must_be_true,
  not has_function_privilege('anon', 'public.manager_resolve_expired_order(uuid,text,text,integer,date,text,date,date)', 'execute')      as rpc_not_executable_by_anon_must_be_true,
  (select count(*) from pg_trigger where tgrelid = 'public.orders'::regclass and tgname = 'orders_guard_expired_resolution' and not tgisinternal and tgenabled <> 'D') as status_guard_trigger_must_be_1,
  not has_function_privilege('authenticated', 'public.orders_guard_expired_resolution()', 'execute') as guard_fn_not_callable_must_be_true,
  (select count(*) from pg_trigger where tgrelid = 'public.orders'::regclass and tgname in ('orders_guard_status_transition','orders_restore_points_on_cancel') and not tgisinternal) as existing_order_triggers_still_2_must_be_2,
  (select count(*) from order_expiry_resolutions)                                                                          as resolution_rows_info,
  (select count(*) from orders o join products p on p.id = o.product_id where o.status = 'pending' and fixed_expiry_passed(p.expiry_mode, p.expiry_date)) as expired_pending_orders_info;
