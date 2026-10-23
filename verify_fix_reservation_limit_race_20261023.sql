-- 읽기 전용: 두 함수에 잠금 마커가 있는지(적용 후 true,true)
select p.proname, position('limit-race-lock' in pg_get_functiondef(p.oid)) > 0 as has_lock
  from pg_proc p where p.proname in ('reserve_class','reserve_with_membership') order by 1;
