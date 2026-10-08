-- add_phone_otp_send_limits_20261008.sql 롤백 — 이번에 추가한 함수 1개와 테이블 1개만 제거한다(다른 객체는 건드리지 않음).
drop function if exists consume_phone_otp_send_attempt(text, int, int);
drop table if exists phone_otp_send_attempts;
