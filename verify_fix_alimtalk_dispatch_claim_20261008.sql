-- READ-ONLY 확인(SELECT만) — 한 문장씩 실행. "적용 전" 점검(3번)은 마이그레이션 실행 전에도 쓸 수 있다.
-- 1) 컬럼 존재(적용 후)
select table_name, column_name, data_type
from information_schema.columns
where table_schema = 'public'
  and ((table_name = 'messages' and column_name = 'claimed_at')
    or (table_name = 'notification_logs' and column_name in ('message_id', 'error')))
order by table_name, column_name;

-- 2) 유일 인덱스(적용 후)
select indexname, indexdef from pg_indexes
where schemaname = 'public' and indexname in ('uq_notification_logs_message_profile_sent', 'idx_notification_logs_message_id');

-- 3) service_role 권한 — 적용 전: select/update가 false면 큐 디스패치가 지금도 막혀 있다는 뜻. 적용 후: select=true, update=(컬럼 단위라 테이블 update는 false가 정상)
select has_table_privilege('service_role', 'public.messages', 'select') as svc_select,
       has_table_privilege('service_role', 'public.messages', 'update') as svc_table_update,
       has_column_privilege('service_role', 'public.messages', 'status', 'update') as svc_update_status,
       has_column_privilege('service_role', 'public.messages', 'sent_at', 'update') as svc_update_sent_at,
       has_column_privilege('service_role', 'public.messages', 'claimed_at', 'update') as svc_update_claimed_at;

-- 4) 현황(변경 아님): 오래 'scheduled'로 남은 알림톡 큐 행 — 적용 전에 많이 쌓여 있으면 디스패치가 막혀 있었다는 신호
select status, count(*) as n, min(created_at) as oldest
from public.messages
where channel = 'alimtalk'
group by status
order by status;
