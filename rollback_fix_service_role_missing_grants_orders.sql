-- fix_service_role_missing_grants_orders.sql 롤백
revoke select, insert, update, delete on orders from service_role;
