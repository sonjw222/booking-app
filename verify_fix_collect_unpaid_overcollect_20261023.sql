-- 읽기 전용 점검(F18). 적용 전: 운영 정의가 repo 의 add_payments_unpaid_link.sql 과 같은지 확인(정의 해시 비교는 Codex 가 수행).
-- 1) 함수 정의에 초과 회수 가드가 있는지(적용 후 true)
select position('남은 미수금' in pg_get_functiondef('public.collect_unpaid_payment(uuid,numeric,numeric,numeric,numeric,timestamptz,text)'::regprocedure)) > 0 as has_cap_guard;
-- 2) 실행 권한(적용 후: authenticated true, anon false)
select has_function_privilege('anon','public.collect_unpaid_payment(uuid,numeric,numeric,numeric,numeric,timestamptz,text)','execute') as anon_exec,
       has_function_privilege('authenticated','public.collect_unpaid_payment(uuid,numeric,numeric,numeric,numeric,timestamptz,text)','execute') as authed_exec;
-- 3) 과거 초과 회수 여부: 원래 미수금은 별도 컬럼으로 남지 않아(회수 시 unpaid_amount 를 차감) SQL 로 확정할 수 없다. 이 SQL 은 데이터를 보정하지 않는다.
--    수동 대조용으로 회수 연결이 있는 원본의 (현재 미수, 회수 합계)만 본다.
select o.id as original_payment_id, o.center_id, o.unpaid_amount as unpaid_now, sum(c.total_amount) as collected_total, count(*) as collect_count
  from payments o join payments c on c.linked_unpaid_payment_id = o.id and c.sale_type = 'unpaid_pay'
 group by o.id, o.center_id, o.unpaid_amount order by collected_total desc limit 50;
