-- 읽기 전용 사전 점검 — 공개 목록(/products)에 남은 "테스트"(100원, 만료일 없음) 상품을 비공개(판매 정지)하기 전에 SQL Editor 에서 실행한다. 변경 없음.
-- 대상은 2026-10-27 읽기 전용 조회로 식별한 1건: A10TION 피겨팀(8965e09c-…)의 상품 964ffd69-…. 이름·가격·센터가 다르면(운영에서 바뀐 것) 적용 SQL 이 스스로 중단한다.
-- ① 대상 상품 현재 상태(1행이어야 함)
select id, center_id, name, price, product_kind, expiry_mode, is_active, is_on_sale, visibility_type
  from products where id = '964ffd69-1f03-4193-a8c8-d2f5d4ed8111';
-- ② 이 상품을 참조하는 주문·수강권(정보): 판매 정지는 기존 주문·수강권에 영향이 없다(행을 삭제·수정하지 않음)
select (select count(*) from orders where product_id = '964ffd69-1f03-4193-a8c8-d2f5d4ed8111') as orders_info,
       (select count(*) from orders where product_id = '964ffd69-1f03-4193-a8c8-d2f5d4ed8111' and status = 'pending') as pending_orders_info,
       (select count(*) from memberships where product_id = '964ffd69-1f03-4193-a8c8-d2f5d4ed8111') as memberships_info;
-- ③ 이 센터의 공개 판매 상품 수(숨긴 뒤 이 값에서 1 줄어든다). 0이 되면 /products 는 "현재 판매 중인 상품이 없어요"로 표시된다 — 심사 전 실제 판매 상품 등록 필요
select count(*) as public_visible_products_in_center
  from public.fetch_public_storefront_products('8965e09c-0d2b-44c6-ab26-40a85507f8b5'::uuid);
