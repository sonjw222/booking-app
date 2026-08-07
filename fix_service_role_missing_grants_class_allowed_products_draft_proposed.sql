-- service_role에 class_allowed_products 테이블 GRANT 추가.
-- 배경: fix_service_role_missing_grants_for_e2e_admin_draft_proposed.sql/
-- fix_service_role_missing_grants_products.sql/
-- fix_service_role_missing_grants_membership_schedule_rules_draft_proposed.sql/
-- fix_service_role_missing_grants_profiles_draft_proposed.sql와 동일한 원인 — 신규 테이블에
-- service_role GRANT가 빠져 있었다. E2E 테스트 진단 코드가 service-role 클라이언트로
-- class_allowed_products를 조회하다 결과가 null로 나와(에러가 조용히 삼켜짐) "permission
-- denied for table class_allowed_products"를 실제로 재현했다.
grant select, insert, update, delete on class_allowed_products to service_role;
