-- ============================================================
-- ROLLBACK for fix_service_role_grants_class_allowed_products_minimal_draft_proposed.sql
-- DO NOT RUN unless you need to revert that GRANT.
-- ============================================================

BEGIN;

revoke select, insert, delete on class_allowed_products from service_role;

COMMIT;
