-- service_role에 center_members 테이블 GRANT 추가.
-- 배경: fix_service_role_missing_grants_profiles_draft_proposed.sql 등과 동일한 원인 —
-- 신규 테이블에 service_role GRANT가 빠져 있었다. manager-centers-privilege-escalation
-- 통합테스트(K: 회원 관계와 manager_centers 관계의 독립성)가 admin(service-role) 클라이언트로
-- center_members에 직접 insert하다 "permission denied for table center_members"가 실제로
-- 재현됐다(GRANT SELECT, INSERT ON public.center_members TO service_role 안내 메시지까지 확인).
grant select, insert, update, delete on center_members to service_role;
