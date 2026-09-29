-- add_email_signup_precheck.sql 롤백 — 이번에 새로 추가한 함수 2개와 테이블 1개만 제거.
-- 다른 production 객체(다른 함수/테이블/RLS 정책 등)는 전혀 건드리지 않는다.
drop function if exists email_signup_available(text);
drop function if exists consume_email_check_attempt(text);
drop table if exists email_check_attempts;

-- 확인(모두 0이어야 정상 롤백)
select
  (select count(*) from pg_proc where proname = 'email_signup_available') as email_signup_available_remaining,
  (select count(*) from pg_proc where proname = 'consume_email_check_attempt') as consume_email_check_attempt_remaining,
  (select count(*) from pg_tables where tablename = 'email_check_attempts') as table_remaining;
