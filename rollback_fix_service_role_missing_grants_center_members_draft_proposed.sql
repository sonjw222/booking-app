-- ============================================================
-- fix_service_role_missing_grants_center_members_draft_proposed.sql 롤백
--
-- service_role에 준 center_members GRANT를 회수한다. ⚠ 이 롤백을 적용하면
-- admin(service_role) 클라이언트로 center_members를 직접 조작하는 모든 fixture/관리
-- 스크립트가 다시 "permission denied for table center_members"로 막힌다 — GRANT
-- 자체가 새로운 권한을 여는 게 아니라(RLS는 별개로 계속 적용됨) service_role의
-- 기본 테이블 접근 gap을 메운 것뿐이므로, 되돌릴 이유가 특별히 없는 한 사용하지 말 것.
--
-- 여러 번 실행해도 안전.
-- ============================================================

revoke select, insert, update, delete on center_members from service_role;

-- ============================================================
-- 완료. service_role의 center_members GRANT가 적용 이전 상태(GRANT 없음)로 복원됨.
-- ============================================================
