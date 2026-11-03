-- 읽기 전용 확인: add_nicepay_review_real_center_grants_20261103.sql 적용 후 SQL Editor 에서 실행(데이터를 바꾸지 않는다). 기대값은 각 줄 주석.
select 'table_exists' as check, to_regclass('public.nicepay_review_center_grants') is not null as ok;                                       -- true
select 'rls_enabled_no_policies' as check, c.relrowsecurity and not exists (select 1 from pg_policies p where p.tablename='nicepay_review_center_grants') as ok
  from pg_class c where c.oid = 'public.nicepay_review_center_grants'::regclass;                                                              -- true
select 'no_client_privileges' as check, not has_table_privilege('anon','public.nicepay_review_center_grants','select')
  and not has_table_privilege('authenticated','public.nicepay_review_center_grants','select') as ok;                                         -- true
select 'functions' as check, to_regprocedure('nicepay_review_center_granted(uuid)') is not null and to_regprocedure('nicepay_review_center_purchase_allowed(uuid)') is not null
  and to_regprocedure('nicepay_my_review_center_ids()') is not null as ok;                                                                   -- true
select 'guard_uses_purchase_allowed' as check, pg_get_functiondef('nicepay_review_guard_center()'::regprocedure) like '%nicepay_review_center_purchase_allowed%' as ok;  -- true
select 'gate_unchanged' as check, pg_get_functiondef('nicepay_order_is_review_target(uuid,uuid)'::regprocedure) like '%is_nicepay_review%' as ok;                    -- true (카드 결제 게이트는 심사 센터만)
select 'grants_rows' as check, count(*) as rows, count(*) filter (where can_purchase) as purchase_rows from nicepay_review_center_grants;  -- 지정 전 0/0
select 'review_flag_accounts' as check, count(*) as reviewers from accounts where nicepay_review_access;
select 'grants_target_centers' as check, c.name, g.can_purchase from nicepay_review_center_grants g join centers c on c.id=g.center_id order by c.name;
