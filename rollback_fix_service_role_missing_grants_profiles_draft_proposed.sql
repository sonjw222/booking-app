-- fix_service_role_missing_grants_profiles_draft_proposed.sql 롤백
revoke select, insert, update, delete on profiles from service_role;
