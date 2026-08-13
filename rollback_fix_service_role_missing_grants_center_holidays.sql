-- fix_service_role_missing_grants_center_holidays.sql 롤백
revoke select, insert, update, delete on center_holidays from service_role;
