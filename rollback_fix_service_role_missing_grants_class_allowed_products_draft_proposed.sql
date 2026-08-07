-- fix_service_role_missing_grants_class_allowed_products_draft_proposed.sql 롤백
revoke select, insert, update, delete on class_allowed_products from service_role;
