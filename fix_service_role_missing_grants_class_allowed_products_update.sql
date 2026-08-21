-- P0-2 운영 DB migration ledger 점검 중 발견: class_allowed_products에 대한
-- service_role GRANT가 SELECT/INSERT/DELETE만 있고 UPDATE가 빠져 있다.
--
-- fix_service_role_missing_grants_class_allowed_products_draft_proposed.sql은 4개
-- 권한(select/insert/update/delete)을 전부 한 문장으로 요청했는데, 라이브 조회
-- (information_schema.role_table_grants)에는 UPDATE만 없는 상태였다 — 그 파일이
-- 부분적으로만 적용됐거나, 이후 어딘가에서 UPDATE만 별도로 REVOKE된 것으로 보이나
-- 정확한 경위는 알 수 없다(GRANT/REVOKE 이력 자체가 남지 않음). 원인과 무관하게
-- 필요한 최종 상태(4개 권한 전부)로 맞추는 게 목적이라 GRANT는 멱등하므로 안전하다.
grant update on class_allowed_products to service_role;
