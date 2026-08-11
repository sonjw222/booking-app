-- fix_service_role_missing_grants_accounts_write_draft_proposed.sql 롤백
revoke insert, update, delete on accounts from service_role;
