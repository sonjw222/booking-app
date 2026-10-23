-- 롤백(F21): 승격 루프 조건을 원래대로(`and expires_at >= current_date`) 되돌린다. 적용 직전 운영 정의 백업이 있으면 그것이 우선.
do $rb$
declare v_def text;
begin
    v_def := pg_get_functiondef('public.cancel_reservation(uuid)'::regprocedure);
    if v_def ~* 'and\s+\(expires_at\s+is\s+null\s+or\s+expires_at\s*>=\s*current_date\)' then
        v_def := regexp_replace(v_def, 'and\s+\(expires_at\s+is\s+null\s+or\s+expires_at\s*>=\s*current_date\)', 'and expires_at >= current_date', 'i');
        execute v_def;
    end if;
end
$rb$;
