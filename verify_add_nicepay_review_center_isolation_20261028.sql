-- 읽기 전용 확인(SQL Editor/postgres 로 실행 — 변경 없음). 역할별 가시성은 아래 "역할 시뮬레이션"으로 확인한다.
-- 1) 객체
select
  (select count(*) from information_schema.columns where table_schema='public'
     and ((table_name='centers' and column_name='is_nicepay_review') or (table_name='accounts' and column_name='nicepay_review_access'))) as columns_must_be_2,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname='public'
     and p.proname in ('nicepay_is_reviewer','nicepay_review_center_allowed','nicepay_review_center_member_allowed','nicepay_class_has_my_reservation','nicepay_review_guard_center','enforce_center_nicepay_review_admin_only','enforce_nicepay_review_access_admin_only','nicepay_is_client_request')) as new_functions_must_be_8,
  (select count(*) from pg_policies where policyname='nicepay_review_isolation') as restrictive_policies_must_be_3,
  (select count(*) from pg_policies where policyname='nicepay_own_reservation_class') as own_reservation_policy_must_be_1,
  (select count(*) from pg_trigger where not tgisinternal and tgname ~ '^trg_(centers|accounts|orders|memberships|cart_items|purchase_requests|reservations)_nicepay_review_') as triggers_must_be_12,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname='public'
     and p.proname in ('fetch_public_storefront_products','fetch_purchasable_products','fetch_public_storefront_product_periods')
     and position('nicepay_review_center_member_allowed' in pg_get_functiondef(p.oid)) > 0) as list_rpcs_replaced_must_be_3,
  position('nicepay_review_center_allowed' in pg_get_functiondef('public.center_rows_visible(uuid)'::regprocedure)) > 0 as center_rows_visible_replaced_must_be_true,
  (md5(pg_get_functiondef('public.center_rows_visible(uuid)'::regprocedure)) = 'bbbf4e8ea2ce9aac72df0ceddee36243' and md5(pg_get_functiondef('public.fetch_public_storefront_products(uuid)'::regprocedure)) = 'b40c8da87ee36e7cfd6d3e2cb1880d4c' and md5(pg_get_functiondef('public.fetch_purchasable_products(uuid)'::regprocedure)) = '04286c619a7edb2e2becd98b70394f42') as replaced_definitions_match_expected_must_be_true,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname='public'
     and p.proname in ('nicepay_is_reviewer','nicepay_review_center_allowed','nicepay_review_center_member_allowed','nicepay_class_has_my_reservation')
     and has_function_privilege('public', p.oid, 'execute')) as helpers_executable_by_public_must_be_0;
-- 2) 기존 센터 보존: 아래 두 값은 적용 전후 같아야 한다(적용 전에 먼저 기록).
select (select count(*) from centers where not is_nicepay_review) as existing_centers,
       (select count(*) from products p join centers c on c.id=p.center_id where not c.is_nicepay_review) as existing_products;
-- 3) 심사 센터/심사관 현황(심사관 수는 의도한 1명인지 확인)
select (select count(*) from centers where is_nicepay_review) as review_centers,
       (select count(*) from accounts where nicepay_review_access and deactivated_at is null) as nicepay_reviewer_accounts,
       (select count(*) from accounts where pg_checkout_override and deactivated_at is null) as toss_override_accounts_unchanged;
-- 4) 역할 시뮬레이션(트랜잭션 안에서만, 마지막에 ROLLBACK). <일반회원_auth_id>/<심사관_auth_id> 를 실제 값으로 바꿔 실행.
-- begin;
--   set local role authenticated; select set_config('request.jwt.claims', json_build_object('sub','<일반회원_auth_id>','role','authenticated')::text, true);
--   select count(*) as normal_sees_review_center_must_be_0 from centers where is_nicepay_review;
--   select count(*) as normal_sees_operating_centers from centers where not is_nicepay_review;
--   select set_config('request.jwt.claims', json_build_object('sub','<심사관_auth_id>','role','authenticated')::text, true);
--   select count(*) as reviewer_sees_review_center_must_be_1 from centers where is_nicepay_review;
--   select count(*) as reviewer_sees_operating_centers_must_be_0 from centers where not is_nicepay_review;
-- rollback;
