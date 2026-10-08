-- READ-ONLY 확인(SELECT만) — fix_center_insert_guard_20261008.sql 적용 후 한 문장씩 실행.
-- 1) 트리거가 켜져 있는지(tgenabled = 'O')
select t.tgname, t.tgenabled, pg_get_triggerdef(t.oid) as definition
from pg_trigger t
where t.tgrelid = 'public.centers'::regclass and not t.tgisinternal and t.tgname = 'trg_guard_center_insert';

-- 2) 함수 속성(security definer, search_path 고정) 및 API 롤 EXECUTE 회수 확인
select p.proname, p.prosecdef as security_definer, p.proconfig as config,
       has_function_privilege('anon', p.oid, 'execute') as anon_exec,
       has_function_privilege('authenticated', p.oid, 'execute') as authenticated_exec
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'guard_center_insert';

-- 3) 참고(이미 있던 행 점검 — 변경 아님): 사업자등록증 없이 approved인 센터. QA/테스트 센터는 정상적으로 여기 나올 수 있으니 이름/생성시각으로 판단한다.
select id, name, status, is_internal, created_at, (business_license_url is not null) as has_license
from public.centers
where status = 'approved' and business_license_url is null
order by created_at desc;
