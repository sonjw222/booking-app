-- service_role에 profiles 테이블 GRANT 추가.
-- 배경: fix_service_role_missing_grants_for_e2e_admin_draft_proposed.sql/
-- fix_service_role_missing_grants_products.sql/
-- fix_service_role_missing_grants_membership_schedule_rules_draft_proposed.sql와 동일한
-- 원인 — 신규 테이블에 service_role GRANT가 빠져 있었다. P3 통합테스트가 "수강권 0건"
-- 상태를 재현하려고 회원 계정에 추가 프로필을 admin(service-role) 클라이언트로 직접
-- insert하다 "permission denied for table profiles"가 실제로 재현됐다.
grant select, insert, update, delete on profiles to service_role;
