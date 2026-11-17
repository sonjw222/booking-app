-- 적용 확인(읽기 전용): 기대값 — trigger_cnt=1, fn_cnt=1, fn_security_definer=true, fn_not_executable_by_clients=true
select (select count(*) from pg_trigger where tgname = 'orders_validate_selected_size' and not tgisinternal) as trigger_cnt,
       (select count(*) from pg_proc where proname = 'orders_validate_selected_size') as fn_cnt,
       (select bool_and(prosecdef) from pg_proc where proname = 'orders_validate_selected_size') as fn_security_definer,
       not (has_function_privilege('anon', 'public.orders_validate_selected_size()', 'execute')
         or has_function_privilege('authenticated', 'public.orders_validate_selected_size()', 'execute')) as fn_not_executable_by_clients;
