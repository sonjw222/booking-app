-- 읽기 전용 진단 — P1-5b(버킷2 SQL) 작업 전, 아래 함수들의 "실제 라이브" 정의를 확인합니다.
-- 여러 마이그레이션 파일에서 같은 함수가 다르게 재정의된 이력이 있어(fulfill_order,
-- manager_set_attendance), 정적 파일 추측 대신 실제 DB에 있는 정의를 그대로 가져옵니다.
-- 이 쿼리는 아무것도 바꾸지 않습니다(SELECT만).

select
    p.proname as function_name,
    pg_get_functiondef(p.oid) as definition
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('fulfill_order', 'manager_set_attendance')
order by p.proname;
