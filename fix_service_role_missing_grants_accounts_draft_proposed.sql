-- service_role에 accounts 테이블 SELECT GRANT 추가.
-- 배경: fix_service_role_missing_grants_profiles_draft_proposed.sql/
-- fix_service_role_missing_grants_payments_draft_proposed.sql와 동일한 원인 계열 —
-- accounts 테이블에 service_role GRANT가 빠져 있다. 실제 수동 QA 계정(P1-15, docs/TODO.md
-- 참고) 조사용 read-only 진단 스크립트가 auth.users의 auth_id로 accounts.id를 조회하려다
-- "permission denied for table accounts"로 실제 재현됨(CI run 31378194569).
--
-- 이 진단은 오직 SELECT만 필요하므로(계정 존재 여부/account_id 조회), 기존 grant 파일들과
-- 달리 select만 부여한다 — insert/update/delete는 이번 필요에 없어 최소 범위로 제한.
grant select on accounts to service_role;
