-- add_order_self_cancel.sql 롤백
drop policy if exists "주문 본인 취소" on orders;
