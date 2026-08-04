-- fix_service_role_missing_grants_products.sql 롤백
revoke select, insert, update, delete on products from service_role;
