-- add_manager_grant_product_rpc.sql 롤백 — RPC 제거(클라이언트는 자동으로 기존 2단계 지급 경로로 폴백).
-- memberships.selected_size 컬럼은 다른 migration이 쓰므로 여기서 지우지 않는다.
drop function if exists manager_grant_product(uuid, uuid, uuid, integer, text, text, timestamptz, uuid, integer, time, text, integer);
