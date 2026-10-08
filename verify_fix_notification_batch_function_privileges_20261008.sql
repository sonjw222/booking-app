-- READ-ONLY 확인(SELECT만) — 적용 후 실행. 기대: 3개 모두 anon_exec=false, authenticated_exec=false, service_role_exec=true
select p.oid::regprocedure as function,
       has_function_privilege('anon', p.oid, 'execute')          as anon_exec,
       has_function_privilege('authenticated', p.oid, 'execute') as authenticated_exec,
       has_function_privilege('service_role', p.oid, 'execute')  as service_role_exec
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname in ('evaluate_notification_rules', 'notify_expiring_passes', 'notify_upcoming_reservations')
order by p.proname;

-- cron이 이 함수들을 계속 실행하고 있는지(최근 실행 성공 여부) — pg_cron이 있는 프로젝트에서만
select jobid, jobname, schedule, active from cron.job where command ilike '%evaluate_notification_rules%' or command ilike '%notify_expiring_passes%' or command ilike '%notify_upcoming_reservations%';
