-- add_email_signup_precheck.sql 롤백 — 함수/테이블만 제거, 다른 데이터 영향 없음.
drop function if exists email_signup_available(text);
drop table if exists email_check_attempts;

-- 확인(둘 다 0이어야 정상 롤백)
select
  (select count(*) from pg_proc where proname = 'email_signup_available') as function_remaining,
  (select count(*) from pg_tables where tablename = 'email_check_attempts') as table_remaining;
