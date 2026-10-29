-- 읽기 전용 사전 점검 (2026-10-31) — fix_expired_fixed_date_products_20261031.sql 적용 "전에" SQL Editor 에서 실행한다(변경 없음).
-- 기대: 4개 함수 definition_matches_pre = true, 정책 policy_matches_pre = true, 신규 함수 helpers_absent = true, member_can_purchase_hash_unchanged = true.
select
  (select string_agg(p.oid::regprocedure::text || '=' || (md5(pg_get_functiondef(p.oid)) = x.pre)::text, ' | ' order by 1)
     from pg_proc p join (values ('fetch_public_storefront_products','b40c8da87ee36e7cfd6d3e2cb1880d4c'),('fetch_public_storefront_product_periods','a75179807f56a6027b65a3b6ab1bef15'),
          ('fetch_purchasable_products','04286c619a7edb2e2becd98b70394f42'),('create_order_secure','65c18454f065b8cf19f0e6713dd58bee')) as x(n, pre) on x.n = p.proname
    where p.pronamespace = 'public'::regnamespace)                                                                         as definition_matches_pre,
  (select md5(pg_get_expr(polwithcheck, polrelid)) = md5('((profile_id IN ( SELECT my_profile_ids() AS my_profile_ids)) AND ((product_id IS NULL) OR member_can_purchase_product(product_id, profile_id)))') from pg_policy where polrelid = 'public.orders'::regclass and polname = '주문 본인 생성') as policy_matches_pre,
  (to_regprocedure('public.fixed_expiry_passed(text,date)') is null and to_regprocedure('public.product_fixed_expiry_passed(uuid)') is null)            as helpers_absent,
  (select md5(pg_get_functiondef(oid)) = 'd0233bd03772ad129db6acc90f7e0dba' from pg_proc where oid = 'public.member_can_purchase_product(uuid,uuid)'::regprocedure) as member_can_purchase_hash_unchanged;
-- 영향 범위(참고): 이미 만료된 고정 만료일 상품 수 — 적용하면 이 중 판매 중인 상품이 목록·신규 주문에서 빠진다(데이터는 그대로).
select p.id, p.center_id, p.name, p.expiry_date, p.is_active, p.is_on_sale
  from products p where p.expiry_mode = 'date' and p.expiry_date < (now() at time zone 'Asia/Seoul')::date order by p.expiry_date;
-- 만료 후 확정 대기 중인 주문(참고): 이 SQL 은 이 주문의 확정·발급을 막지 않는다. 만료된 고정 만료일 상품의 pending 주문 수.
select count(*) as pending_orders_on_expired_products from orders o join products p on p.id = o.product_id
 where o.status in ('pending','approving') and p.expiry_mode = 'date' and p.expiry_date < (now() at time zone 'Asia/Seoul')::date;
