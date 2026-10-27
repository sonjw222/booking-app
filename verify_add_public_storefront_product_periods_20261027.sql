-- 읽기 전용 확인: 적용 후 실행. 변경 없음.
-- 1) 함수/권한
select
    to_regprocedure('fetch_public_storefront_product_periods(uuid)') is not null as function_exists,
    has_function_privilege('anon', 'fetch_public_storefront_product_periods(uuid)', 'execute') as anon_can_execute,
    has_function_privilege('authenticated', 'fetch_public_storefront_product_periods(uuid)', 'execute') as authenticated_can_execute,
    has_function_privilege('public', 'fetch_public_storefront_product_periods(uuid)', 'execute') as public_must_be_false;
-- 2) 노출 범위가 기존 공개 목록과 같다(차이 0 이어야 함)
select
    (select count(*) from fetch_public_storefront_products()) as public_products,
    (select count(*) from fetch_public_storefront_product_periods()) as public_periods,
    (select count(*) from fetch_public_storefront_products() a
       where not exists (select 1 from fetch_public_storefront_product_periods() b where b.product_id = a.id)) as missing_in_periods_must_be_0,
    (select count(*) from fetch_public_storefront_product_periods() b
       where not exists (select 1 from fetch_public_storefront_products() a where a.id = b.product_id)) as extra_in_periods_must_be_0;
-- 3) 판매 중 공개 상품의 이용기간 분포(NICEPAY 기준 점검용: none 은 만료일 없음, days>365 는 1년 초과 후보)
select expiry_mode, count(*) as products, max(expiry_days) as max_expiry_days, min(expiry_date) as min_expiry_date, max(expiry_date) as max_expiry_date
from fetch_public_storefront_product_periods() group by expiry_mode order by expiry_mode;
