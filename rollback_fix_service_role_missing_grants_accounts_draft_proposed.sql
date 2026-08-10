-- fix_service_role_missing_grants_accounts_draft_proposed.sql 롤백
revoke select on accounts from service_role;
