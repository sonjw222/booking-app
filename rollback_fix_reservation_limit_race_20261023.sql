-- 롤백: advisory lock 치환을 제거한다(적용 직전 운영 정의 백업이 있으면 그것이 우선).
do $rb$
declare
    v_sig text;
    v_def text;
begin
    foreach v_sig in array array['public.reserve_class(uuid,uuid)', 'public.reserve_with_membership(uuid,uuid,uuid)'] loop
        v_def := pg_get_functiondef(v_sig::regprocedure);
        if v_def like '%-- limit-race-lock%' then
            v_def := regexp_replace(v_def, '\s*perform pg_advisory_xact_lock\(hashtextextended\(''daily-limit:''[^\n\r]*-- limit-race-lock', '', 'gi');
            v_def := regexp_replace(v_def, '\s*perform pg_advisory_xact_lock\(hashtextextended\(''private-concurrent:''[^\n\r]*-- limit-race-lock', '', 'gi');
            execute v_def;
        end if;
    end loop;
end
$rb$;
