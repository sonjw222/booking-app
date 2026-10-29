-- 읽기 전용 확인 (2026-10-31) — fix_expired_fixed_date_products_20261031.sql 적용 "후" 실행. 기대값은 컬럼명대로.
select
  (select count(*) from pg_proc p join (values ('fetch_public_storefront_products','f8c385903d9385900f58dc02254ae616'),('fetch_public_storefront_product_periods','a1ad0e63c292f287fc8852d190602139'),
          ('fetch_purchasable_products','060c642011bf72e4d14533db58bc552f'),('create_order_secure','3012e68e4a87f40521d314e64d7e82e4')) as x(n, post) on x.n = p.proname
    where p.pronamespace = 'public'::regnamespace and md5(pg_get_functiondef(p.oid)) = x.post)                                             as functions_at_expected_hash_must_be_4,
  (select md5(pg_get_expr(polwithcheck, polrelid)) = '35a7c89729127c9c246e01a4ed524f0d' from pg_policy where polrelid = 'public.orders'::regclass and polname = '주문 본인 생성') as orders_policy_updated_must_be_true,
  (to_regprocedure('public.fixed_expiry_passed(text,date)') is not null and to_regprocedure('public.product_fixed_expiry_passed(uuid)') is not null)         as helpers_exist_must_be_true,
  (select md5(pg_get_functiondef(oid)) = 'd0233bd03772ad129db6acc90f7e0dba' from pg_proc where oid = 'public.member_can_purchase_product(uuid,uuid)'::regprocedure) as member_can_purchase_unchanged_must_be_true,
  (select count(*) from pg_proc where oid = 'public.fetch_public_storefront_products(uuid)'::regprocedure and pg_get_functiondef(oid) like '%nicepay_review_center_member_allowed%') +
  (select count(*) from pg_proc where oid = 'public.fetch_public_storefront_product_periods(uuid)'::regprocedure and pg_get_functiondef(oid) like '%nicepay_review_center_member_allowed%') +
  (select count(*) from pg_proc where oid = 'public.fetch_purchasable_products(uuid)'::regprocedure and pg_get_functiondef(oid) like '%nicepay_review_center_member_allowed%')   as nicepay_isolation_kept_in_3_functions_must_be_3,
  public.fixed_expiry_passed('date', (now() at time zone 'Asia/Seoul')::date - 1)                                                                 as yesterday_expired_must_be_true,
  public.fixed_expiry_passed('date', (now() at time zone 'Asia/Seoul')::date)                                                                     as today_expired_must_be_false,
  public.fixed_expiry_passed('date', (now() at time zone 'Asia/Seoul')::date + 1)                                                                 as tomorrow_expired_must_be_false,
  public.fixed_expiry_passed('days', date '2000-01-01')                                                                                           as days_mode_expired_must_be_false;
-- 만료된 판매 중 상품이 공개 목록에서 빠졌는지(기대 0): 
select count(*) as expired_products_still_in_public_list_must_be_0
  from fetch_public_storefront_products(null) f join products p on p.id = f.id where p.expiry_mode = 'date' and p.expiry_date < (now() at time zone 'Asia/Seoul')::date;
