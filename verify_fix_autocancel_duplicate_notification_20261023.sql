-- 읽기 전용 점검: 두 함수에 마커가 있는지(적용 후 true,true), 스윕의 실행 권한 유지(service_role만)
select position('sys-cancel-dedupe' in pg_get_functiondef('public.trg_notify_reservation_update()'::regprocedure)) > 0 as trigger_patched,
       position('sys-cancel-dedupe' in pg_get_functiondef('public.run_autocancel_sweep()'::regprocedure)) > 0 as sweep_patched;
select has_function_privilege('anon','public.run_autocancel_sweep()','execute') as anon_exec,
       has_function_privilege('authenticated','public.run_autocancel_sweep()','execute') as authed_exec,
       has_function_privilege('service_role','public.run_autocancel_sweep()','execute') as service_exec;
