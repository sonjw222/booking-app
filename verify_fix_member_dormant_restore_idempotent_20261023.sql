-- 읽기 전용 점검(F19)
select position('휴면 회차 소비' in pg_get_functiondef('public.extend_passes_after_dormant(uuid)'::regprocedure)) > 0 as consumes_cycle;
select to_regprocedure('public.set_center_member_status(uuid,text)') is not null as new_rpc_exists;
select has_function_privilege('anon','public.set_center_member_status(uuid,text)','execute') as anon_exec,
       has_function_privilege('authenticated','public.set_center_member_status(uuid,text)','execute') as authed_exec;
-- 현재 휴면 중인 회원(참고: 적용 후에도 이 행들의 복구 연장은 1회만 일어난다)
select count(*) as dormant_members, count(*) filter (where dormant_since is null) as dormant_without_since from center_members where status = 'dormant';
