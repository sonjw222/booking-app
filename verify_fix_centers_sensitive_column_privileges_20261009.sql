-- READ-ONLY 확인(SELECT만) — fix_centers_sensitive_column_privileges_20261009.sql 적용 후 한 문장씩 실행.
-- 1) 민감 3개: anon/authenticated 모두 false 여야 한다
select r.role, c.col, has_column_privilege(r.role, 'public.centers', c.col, 'select') as can_select
from (values ('anon'), ('authenticated')) r(role)
cross join (values ('business_number'), ('business_license_url'), ('reject_reason')) c(col)
order by 1, 2;

-- 2) 공개 컬럼(허용 목록 19개): anon/authenticated 모두 true 여야 한다(false가 있으면 앱 화면이 깨질 수 있음)
select r.role, c.col, has_column_privilege(r.role, 'public.centers', c.col, 'select') as can_select
from (values ('anon'), ('authenticated')) r(role)
cross join unnest(array['id','name','categories','address','phone','intro','intro_blocks','pay_methods','photo_url','sns',
                        'latitude','longitude','status','payment_methods','created_at','instagram','kakao','review_point','is_internal']) c(col)
order by 1, 2;

-- 3) 테이블 단위 SELECT가 남아 있지 않아야 한다(둘 다 false). service_role은 true 여야 한다.
select has_table_privilege('anon','public.centers','select') as anon_table_select,
       has_table_privilege('authenticated','public.centers','select') as authenticated_table_select,
       has_table_privilege('service_role','public.centers','select') as service_role_table_select;

-- 4) INSERT/UPDATE 권한이 그대로인지(참고): authenticated 는 기존대로 true
select has_table_privilege('authenticated','public.centers','insert') as auth_insert,
       has_table_privilege('authenticated','public.centers','update') as auth_update;

-- 5) 허용 목록 밖 컬럼에 SELECT 권한이 열려 있지 않은지 — 결과가 0행이어야 한다(예상 밖 컬럼이 자동 공개되지 않았다는 확인)
select r.role, a.attname as col
from (values ('anon'), ('authenticated')) r(role)
cross join pg_attribute a
where a.attrelid = 'public.centers'::regclass and a.attnum > 0 and not a.attisdropped
  and has_column_privilege(r.role, 'public.centers', a.attname, 'select')
  and a.attname <> all (array['id','name','categories','address','phone','intro','intro_blocks','pay_methods','photo_url','sns',
                              'latitude','longitude','status','payment_methods','created_at','instagram','kakao','review_point','is_internal']);

-- 6) 앱 확인(비로그인): https://<project>.supabase.co/rest/v1/centers?select=name 은 200,
--    ?select=business_number 와 ?select=* 는 401(42501 permission denied)
