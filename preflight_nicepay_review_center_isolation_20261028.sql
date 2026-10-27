-- 읽기 전용 사전 점검 — add_nicepay_review_center_isolation_20261028.sql 을 운영에 적용하기 "전에" SQL Editor 에서 실행한다(변경 없음).
-- 분리 SQL 은 아래 3개 함수를 "현재 정의 + 한 줄 조건"으로 통째로 다시 만든다. 운영의 현재 정의가 아래 기대값(공유 DEV 와 같은 계보의 정의, 2026-10-28 로컬 측정)과 다르면
-- 운영에서 따로 바뀐 내용을 덮어쓸 수 있으므로 적용하지 말고 이 결과를 보내 정의 차이를 먼저 비교한다.
select 'center_rows_visible' as object, md5(pg_get_functiondef('public.center_rows_visible(uuid)'::regprocedure)) as actual_md5, '2be0d75899571b973f43d213713053e3' as expected_md5,
       md5(pg_get_functiondef('public.center_rows_visible(uuid)'::regprocedure)) = '2be0d75899571b973f43d213713053e3' as matches
union all select 'fetch_public_storefront_products', md5(pg_get_functiondef('public.fetch_public_storefront_products(uuid)'::regprocedure)), 'fda8e1821f997e9879c757187ab35a84',
       md5(pg_get_functiondef('public.fetch_public_storefront_products(uuid)'::regprocedure)) = 'fda8e1821f997e9879c757187ab35a84'
union all select 'fetch_purchasable_products', md5(pg_get_functiondef('public.fetch_purchasable_products(uuid)'::regprocedure)), '675be9c77818e1eb61552fc483e51b18',
       md5(pg_get_functiondef('public.fetch_purchasable_products(uuid)'::regprocedure)) = '675be9c77818e1eb61552fc483e51b18';
-- 전제 객체/컬럼(모두 true 여야 함)
select to_regprocedure('my_account_id()') is not null as my_account_id,
       to_regprocedure('my_managed_center_ids()') is not null as my_managed_center_ids,
       to_regprocedure('is_platform_admin()') is not null as is_platform_admin,
       exists (select 1 from information_schema.columns where table_schema='public' and table_name='accounts' and column_name='pg_checkout_override') as pg_checkout_override_col,
       exists (select 1 from information_schema.columns where table_schema='public' and table_name='centers' and column_name='is_internal') as is_internal_col,
       not exists (select 1 from information_schema.columns where table_schema='public' and table_name='centers' and column_name='is_nicepay_review') as not_yet_applied,
       to_regprocedure('fetch_public_storefront_product_periods(uuid)') is not null as periods_rpc_exists_now;
-- 현재 센터/상품/수업 조회 정책(눈으로 확인: 승인된 센터 + is_internal 규칙이어야 함)
select tablename, policyname, pg_get_expr(q.polqual, q.polrelid) as using_expr from pg_policies p join pg_policy q on q.polname = p.policyname and q.polrelid = ('public.' || p.tablename)::regclass
 where p.tablename in ('centers','classes','products') and p.cmd = 'SELECT' order by 1, 2;
-- 영향 범위 미리보기: 심사관 계정 수와 내부/심사 후보 센터
select (select count(*) from accounts where pg_checkout_override and deactivated_at is null) as reviewer_accounts_now,
       (select string_agg(name, ' | ') from accounts where pg_checkout_override and deactivated_at is null) as reviewer_names,
       (select count(*) from centers) as centers_total, (select count(*) from centers where is_internal) as centers_internal;
-- NICEPAY 결제 DB 기반 적용 상태(운영 이력상 2026-10-17 적용): 모두 true 여야 하고, 게이트 mode 는 off 여야 안전하다.
select to_regprocedure('public.nicepay_checkout_mode()') is not null as gate_fn,
       to_regprocedure('public.nicepay_claim_order(uuid)') is not null as claim_fn,
       to_regprocedure('public.orders_guard_nicepay_create()') is not null as gate_trigger_fn,
       to_regclass('public.nicepay_checkout_gate') is not null as gate_table,
       (select mode from nicepay_checkout_gate where id) as gate_mode_now,
       position('pg_checkout_override' in pg_get_functiondef('public.orders_guard_nicepay_create()'::regprocedure)) > 0 as gate_uses_toss_flag_now,
       position('pg_checkout_override' in pg_get_functiondef('public.nicepay_claim_order(uuid)'::regprocedure)) > 0 as claim_uses_toss_flag_now;
