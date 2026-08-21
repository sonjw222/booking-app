-- 읽기 전용 진단 — classes 관련 own/other 세분권한 설계 전, 실제 라이브 정의를 확인합니다.
-- fulfill_order에서 정적 파일이 최신이 아니었던 걸 확인했으니, delete_class_safe/
-- delete_class_group_safe도 같은 방식으로 먼저 확인합니다. 아무것도 바꾸지 않습니다.

select p.proname as function_name, pg_get_functiondef(p.oid) as definition
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('delete_class_safe', 'delete_class_group_safe')
order by p.proname;
