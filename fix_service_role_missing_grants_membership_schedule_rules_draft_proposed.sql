-- service_role에 membership_schedule_rules 테이블 GRANT 추가.
-- 배경: fix_service_role_missing_grants_for_e2e_admin_draft_proposed.sql이 이미 이
-- 프로젝트에서 같은 부류의 문제(center_settings/classes/memberships/reservations)를
-- 고쳤고, fix_service_role_missing_grants_products.sql이 products를 추가로 고쳤다.
-- membership_schedule_rules는 지금까지 항상 인증된 매니저 클라이언트(RLS: has_permission
-- (center_id, 'pass.update'))로만 쓰였는데, P3 E2E 테스트 fixture가 "선택 해제(전체 허용)"
-- 시나리오 검증을 위해 service-role 클라이언트로 이 테이블을 직접 정리(delete)하려다
-- "permission denied for table membership_schedule_rules"가 실제로 재현됐다 — products와
-- 동일한 원인(신규 테이블에 service_role GRANT가 누락됨)이다.
grant select, insert, update, delete on membership_schedule_rules to service_role;
