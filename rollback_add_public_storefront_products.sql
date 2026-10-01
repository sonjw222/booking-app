-- ============================================================
-- add_public_storefront_products.sql 롤백 — 공개 상품 조회 RPC 제거.
-- 기존 fetch_purchasable_products()(회원용)는 건드리지 않으므로 이 롤백이 회원 구매 흐름에
-- 영향을 주지 않는다. 롤백 후에는 비로그인 사용자의 센터 상품 목록 조회가 다시 실패한다
-- (이 migration 이전 상태).
-- ============================================================
drop function if exists fetch_public_storefront_products(uuid);
