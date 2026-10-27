-- 읽기 전용 확인(SQL Editor/postgres 로 실행 — 변경 없음). 역할별 가시성은 아래 "역할 시뮬레이션"으로 확인한다.
-- 1) 객체
select
  (select count(*) from information_schema.columns where table_name='centers' and column_name='is_nicepay_review') as column_must_be_1,
  to_regprocedure('nicepay_review_center_allowed(uuid)') is not null as fn_allowed,
  to_regprocedure('nicepay_is_reviewer()') is not null as fn_reviewer,
  (select count(*) from pg_policies where policyname='nicepay_review_isolation') as restrictive_policies_must_be_3,
  (select count(*) from pg_policies where policyname='nicepay_own_reservation_class') as own_reservation_policy_must_be_1,
  (select count(*) from pg_trigger where tgname like '%nicepay_review%' and not tgisinternal) as triggers_must_be_11,
  has_function_privilege('public','nicepay_review_center_allowed(uuid)','execute') as public_exec_must_be_false;
-- 2) 기존 센터 보존: 아래 두 값은 적용 전후 같아야 한다(적용 전에 먼저 기록).
select (select count(*) from centers where not is_nicepay_review) as existing_centers,
       (select count(*) from products p join centers c on c.id=p.center_id where not c.is_nicepay_review) as existing_products;
-- 3) 심사 센터/심사관 현황(심사관 수는 의도한 1명인지 확인)
select (select count(*) from centers where is_nicepay_review) as review_centers,
       (select count(*) from accounts where pg_checkout_override and deactivated_at is null) as reviewer_accounts;
-- 4) 역할 시뮬레이션(트랜잭션 안에서만, 마지막에 ROLLBACK). <일반회원_auth_id>/<심사관_auth_id> 를 실제 값으로 바꿔 실행.
-- begin;
--   set local role authenticated; select set_config('request.jwt.claims', json_build_object('sub','<일반회원_auth_id>','role','authenticated')::text, true);
--   select count(*) as normal_sees_review_center_must_be_0 from centers where is_nicepay_review;
--   select count(*) as normal_sees_operating_centers from centers where not is_nicepay_review;
--   select set_config('request.jwt.claims', json_build_object('sub','<심사관_auth_id>','role','authenticated')::text, true);
--   select count(*) as reviewer_sees_review_center_must_be_1 from centers where is_nicepay_review;
--   select count(*) as reviewer_sees_operating_centers_must_be_0 from centers where not is_nicepay_review;
-- rollback;
