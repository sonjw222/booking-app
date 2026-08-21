-- ============================================================
-- ROLLBACK for fix_service_role_grants_admin_action_logs_minimal_draft_proposed.sql
-- DO NOT RUN unless you need to revert that GRANT.
-- ============================================================

BEGIN;

revoke select, delete on admin_action_logs from service_role;

COMMIT;
