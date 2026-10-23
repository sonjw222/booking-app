-- 롤백: fix_autocancel_duplicate_notification_20261023.sql 이 넣은 두 군데를 역치환한다(적용 직전 운영 정의 백업이 있으면 그것이 우선).
do $rb$
declare
    v_trg   text;
    v_sweep text;
begin
    v_trg   := pg_get_functiondef('public.trg_notify_reservation_update()'::regprocedure);
    v_sweep := pg_get_functiondef('public.run_autocancel_sweep()'::regprocedure);
    if v_trg like '%-- sys-cancel-dedupe%' then
        v_trg := regexp_replace(v_trg, 'if v_account is not null and coalesce\(current_setting\(''app.system_class_cancel'', true\), ''''\) <> ''on'' then -- sys-cancel-dedupe', 'if v_account is not null then', 'i');
        execute v_trg;
    end if;
    if v_sweep like '%-- sys-cancel-dedupe%' then
        v_sweep := regexp_replace(v_sweep, '\s*perform set_config\(''app.system_class_cancel'', ''on'', true\); -- sys-cancel-dedupe[^\n\r]*', '', 'i');
        v_sweep := regexp_replace(v_sweep, 'perform set_config\(''app.system_class_cancel'', '''', true\);\s*return json_build_object', 'return json_build_object', 'i');
        execute v_sweep;
    end if;
end
$rb$;
