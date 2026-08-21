-- 롤백: add_register_center_for_account_safe_rpc.sql
-- 주의: unique 인덱스를 지우면 그 사이 다시 사업자등록번호 중복 등록이 가능해집니다.

drop function if exists register_center_for_account_safe(text, text, text, text, text);
drop index if exists centers_business_number_unique;
