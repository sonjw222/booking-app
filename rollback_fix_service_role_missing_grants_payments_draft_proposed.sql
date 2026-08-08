-- fix_service_role_missing_grants_payments_draft_proposed.sql 롤백
revoke select, insert, update, delete on payments from service_role;
