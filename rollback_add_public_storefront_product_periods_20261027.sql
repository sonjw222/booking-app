-- add_public_storefront_product_periods_20261027.sql 되돌리기 — 새로 추가한 함수 하나만 지운다(다른 객체·데이터 영향 없음).
-- 앱은 함수가 없으면 공통 안내로 자동 폴백한다.
drop function if exists fetch_public_storefront_product_periods(uuid);
