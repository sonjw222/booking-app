-- READ-ONLY 확인(SELECT만) — add_phone_otp_send_limits_20261008.sql 적용 후 한 문장씩 실행.
-- 1) 함수 존재 + SECURITY DEFINER + search_path 고정 + API 롤 실행 권한 없음(둘 다 false), service_role만 true
select p.proname, p.prosecdef as security_definer, p.proconfig as config,
       has_function_privilege('anon', p.oid, 'execute') as anon_exec,
       has_function_privilege('authenticated', p.oid, 'execute') as authenticated_exec,
       has_function_privilege('service_role', p.oid, 'execute') as service_role_exec
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'consume_phone_otp_send_attempt';

-- 2) 테이블/RLS(켜져 있고 정책이 없어야 anon·authenticated 접근 불가)
select c.relname, c.relrowsecurity as rls_enabled,
       (select count(*) from pg_policies where schemaname = 'public' and tablename = 'phone_otp_send_attempts') as policy_count
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname = 'phone_otp_send_attempts';

-- 3) 운영 점검용(변경 없음): 최근 24시간 발송 시도 수와 IP 해시별 상위
select count(*) as sends_last_24h from public.phone_otp_send_attempts where created_at >= now() - interval '24 hours';
select ip_hash, count(*) as sends_last_hour from public.phone_otp_send_attempts where created_at >= now() - interval '1 hour' group by ip_hash order by 2 desc limit 10;
