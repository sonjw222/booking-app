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
select 'function_state' as check, t.name,
       case md5(pg_get_functiondef(to_regprocedure('public.'||t.name))) when t.pre then 'BEFORE(적용 전 운영 정의)' when t.post then 'APPLIED(이 파일 적용본)' else 'UNKNOWN — 확인 필요' end as state   -- 적용 후 3줄 모두 APPLIED
from (values ('nicepay_review_center_allowed(uuid)','636cb33ff0feaf95244ef0c41c3eb923','078ffecea883196dd869512aa1cbc938'),
             ('nicepay_review_center_member_allowed(uuid)','a3a299f743087d104ebf41948e464d94','030f304bb08fbc2efb67e8ecbc40669f'),
             ('nicepay_review_guard_center()','0e8dc90f9da6cb921225657ba6ae4fb4','7b5c7ca9333d0e7a90fdc559690ab07e')) as t(name, pre, post);
select 'grants_valid_center_conditions' as check, pg_get_functiondef('nicepay_review_center_granted(uuid)'::regprocedure) like '%c.status = ''approved'' and not c.is_internal and not c.is_nicepay_review%' as ok;   -- true (승인 취소·내부 전환 시 즉시 무효)
select 'grants_rows' as check, count(*) as rows, count(*) filter (where can_purchase) as purchase_rows from nicepay_review_center_grants;  -- 지정 전 0/0
select 'review_flag_accounts' as check, count(*) as reviewers from accounts where nicepay_review_access;
select 'grants_target_centers' as check, c.name, g.can_purchase from nicepay_review_center_grants g join centers c on c.id=g.center_id order by c.name;
