-- fix_service_role_grants_contracts_notification_logs.sql 롤백
revoke select, insert, update, delete on contracts from service_role;
revoke select, insert, update, delete on notification_logs from service_role;
