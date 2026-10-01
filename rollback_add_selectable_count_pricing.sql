-- ============================================================
-- add_selectable_count_pricing.sql 롤백 — 트리거/RPC/제약 제거. 가격표 테이블과 컬럼은 데이터 보존을 위해 기본 유지(아래 주석).
-- ⚠ 롤백 전에 횟수 선택형 상품(purchase_count_selectable=true)을 판매중지하세요: 롤백 후에는 price(가격표 최저가)가
--   고정 상품 총액으로 오해되어 최저 회차 금액으로 판매될 수 있습니다. 확인:
--   select id, name from products where purchase_count_selectable;
-- ============================================================
drop trigger if exists orders_snapshot_product_amount on orders;
drop trigger if exists orders_guard_snapshot_update on orders;
drop function if exists orders_snapshot_product_amount();
drop function if exists orders_guard_snapshot_update();
drop function if exists set_product_count_prices(uuid, jsonb);
alter table products drop constraint if exists products_selectable_count_check;

-- 데이터 손실을 피하려고 기본은 주석 처리 — 정말 지울 때만:
-- drop table if exists product_count_prices;
-- alter table products drop column if exists purchase_count_selectable;
-- alter table orders drop column if exists selected_count;
-- alter table orders drop column if exists product_amount_snapshot;
-- alter table cart_items drop column if exists selected_count;
