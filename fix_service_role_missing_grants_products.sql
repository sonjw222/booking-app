-- service_role에 products 테이블 GRANT 추가.
-- 배경: E2E 테스트 수강권이 실제 usable_memberships_for_classes()/usable_memberships()
-- (products를 INNER JOIN)에 노출되도록 product_id를 채우려면, 테스트 fixture(admin/
-- service-role 클라이언트)가 먼저 product_kind='pass' 상품을 get-or-create 해야 한다.
-- 이 과정에서 "permission denied for table products"가 실제로 재현됐다 —
-- fix_service_role_missing_grants_for_e2e_admin_draft_proposed.sql이 이미 이 프로젝트에서
-- 같은 부류의 문제(center_settings/classes/memberships/reservations)를 고친 적이 있는데,
-- 그때 products는 포함되지 않았다.
grant select, insert, update, delete on products to service_role;
