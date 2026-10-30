-- 읽기 전용 확인(P3 후) — seed_nicepay_review_center_20261031_proposed.sql 과 assign_nicepay_reviewer_20261031_proposed.sql 실행 "후" SQL Editor 에서 실행한다. 변경 없음.
-- ① 심사 센터·상품(기대: 센터 1·approved·is_internal=false, 상품 3 = 아래 이름·가격·횟수·기간, 모두 판매 중·공개, 사전예약 없음(days 만료))
select c.name as center, c.status, c.is_internal, c.is_nicepay_review, p.name as product, p.price, p.total_count, p.expiry_mode, p.expiry_days, p.is_active, p.is_on_sale, p.visibility_type
  from centers c join products p on p.center_id = c.id where c.is_nicepay_review order by p.price;
select (select count(*) from centers where is_nicepay_review) as review_centers_must_be_1,
       (select count(*) from products where center_id in (select id from centers where is_nicepay_review)) as review_products_must_be_3,
       (select count(*) from products where center_id in (select id from centers where is_nicepay_review) and is_active and is_on_sale and visibility_type = 'all' and expiry_mode = 'days' and expiry_days <= 90) as active_days_products_must_be_3,
       (select count(*) from center_settings where center_id in (select id from centers where is_nicepay_review)) as settings_must_be_1,
       (select count(*) from center_roles where center_id in (select id from centers where is_nicepay_review)) as roles_info_3;
-- ② 심사관 지정(assign 실행 후 1, 실행 전이면 0)·토스 심사 계정 불변·게이트 상태(결제 열기 전이면 off)
select (select count(*) from accounts where nicepay_review_access) as reviewer_accounts_after_assign_1,
       (select count(*) from accounts where pg_checkout_override) as toss_override_accounts_same_as_preflight,
       (select mode from nicepay_checkout_gate where id) as gate_mode_off_until_reviewing;
-- ③ 기존(비심사) 센터·상품 수가 preflight 에 기록한 값과 같아야 한다(심사 센터 추가 외 변화 없음)
select (select count(*) from centers where not is_nicepay_review) as existing_centers_same_as_preflight,
       (select count(*) from products p where p.center_id in (select id from centers where not is_nicepay_review)) as existing_products_same_as_preflight;
-- ④ 일반 회원에게 보이면 안 된다: 공개 상품 RPC(비로그인 = SQL Editor 에서는 JWT 없음)에 심사 상품이 0건이어야 한다
select count(*) as public_rpc_rows_for_review_products_must_be_0
  from public.fetch_public_storefront_products(null) f where f.center_id in (select id from centers where is_nicepay_review);
