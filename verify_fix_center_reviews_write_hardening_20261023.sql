-- 읽기 전용 점검: 직접 쓰기 권한이 없어야 한다(적용 후 모두 false / insert 컬럼은 5개만 true)
select grantee, privilege_type, count(*) as cols
  from information_schema.column_privileges
 where table_schema = 'public' and table_name = 'center_reviews' and grantee in ('anon','authenticated','PUBLIC') and privilege_type in ('INSERT','UPDATE')
 group by 1,2 order by 1,2;
select has_table_privilege('authenticated','public.center_reviews','update') as authed_table_update,
       has_table_privilege('anon','public.center_reviews','update') as anon_table_update,
       has_table_privilege('authenticated','public.center_reviews','select') as authed_select;
select has_function_privilege('anon','public.reply_review(uuid,text)','execute') as anon_reply_exec;
