-- ============================================================
-- ⚠️ DEVELOPMENT TEST DATA/PERMISSION ROLLBACK ONLY ⚠️
-- fix_service_role_missing_grants_for_e2e_admin_draft_proposed.sql이 추가한
-- service_role GRANT를 되돌린다. 단, classes/memberships/reservations는 실행 전
-- 이미 GRANT가 있었을 수도 있다(이번 CI 실행에서 확인되지 않음) — 그 경우 이 롤백을
-- 실행하면 원래 있던 권한까지 지워질 수 있으니, 먼저 fix 파일의 "실행 전 확인용" SELECT
-- 결과를 다시 보고 실제로 이 파일이 새로 추가한 것만 REVOKE하세요.
-- ============================================================

BEGIN;

revoke select, insert, update, delete on center_settings from service_role;
revoke select, insert, update, delete on classes from service_role;
revoke select, insert, update, delete on memberships from service_role;
revoke select, insert, update, delete on reservations from service_role;

COMMIT;
-- 문제가 발견되면 위 COMMIT 대신 ROLLBACK을 실행하세요.
