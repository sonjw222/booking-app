-- 읽기 전용 사전 점검(P3 전) — seed_nicepay_review_center_20261031_proposed.sql / assign_nicepay_reviewer_20261031_proposed.sql 을 운영에 실행하기 "전에" SQL Editor 에서 실행한다. 변경 없음(SELECT 만).
-- 모든 행이 expected 와 같아야 P3 를 진행한다. 하나라도 다르면 실행하지 말고 결과를 보내 확인한다.
-- ① P2·P2b 적용 상태, 결제 게이트, 기존 심사 센터/심사관 유무
select 'p2_columns_and_policies' as check_name,
       (select count(*) from information_schema.columns where table_schema='public' and ((table_name='centers' and column_name='is_nicepay_review') or (table_name='accounts' and column_name='nicepay_review_access'))) as actual, '2' as expected
union all select 'p2_function_nicepay_review_center_allowed', (to_regprocedure('public.nicepay_review_center_allowed(uuid)') is not null)::int, '1'
union all select 'p2_restrictive_policies_ge_3', (select count(*) from pg_policies where policyname = 'nicepay_review_isolation'), '>=3 (보통 4)'
union all select 'p2b_function_nicepay_order_is_review_target', (to_regprocedure('public.nicepay_order_is_review_target(uuid,uuid)') is not null)::int, '1'
union all select 'gate_mode_must_be_off(0=off)', (select (mode <> 'off')::int from nicepay_checkout_gate where id), '0'
union all select 'existing_review_centers_must_be_0', (select count(*) from centers where is_nicepay_review), '0'
union all select 'existing_reviewer_accounts_must_be_0', (select count(*) from accounts where nicepay_review_access), '0';
-- ② 기준값 기록(실행 후 verify 와 비교): 기존(비심사) 센터 수·상품 수·토스 심사 계정 수 — 이 값은 P3 후에도 같아야 한다
select (select count(*) from centers where not is_nicepay_review) as existing_centers_record_this,
       (select count(*) from products p where p.center_id in (select id from centers where not is_nicepay_review)) as existing_products_record_this,
       (select count(*) from accounts where pg_checkout_override) as toss_override_accounts_record_this;
-- ③ 상품 수 제한(센터 INSERT 시 기본 플랜 연결): 심사 상품 3개를 막는 max_products 가 없어야 한다(null=무제한 또는 3 이상)
select name, max_products, is_default from subscription_plans where is_active order by is_default desc, created_at limit 5;
-- ④ 심사관 후보 계정(이메일을 아래에 넣어 확인 — 그대로 두면 0행): 정확히 1행, nicepay_review_access=false, 이 계정이 관리하는 센터 수를 확인(평소 운영 계정이면 별도 계정 권장)
select a.id as account_id, a.nicepay_review_access, a.pg_checkout_override, (select count(*) from manager_centers mc where mc.account_id = a.id and mc.status = 'active') as managed_active_centers
  from accounts a join auth.users u on u.id = a.auth_id where lower(u.email) = lower('<심사관 이메일 확정 필요>');
