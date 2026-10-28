-- 롤백: orders INSERT 보정의 롤 조건을 제거하고 직전 정의(auth.uid() is not null 만)로 정확히 되돌린다.
begin;

do $$
declare
    v_def text;
begin
    select pg_get_functiondef('public.orders_force_server_fields_on_insert()'::regprocedure) into v_def;
    v_def := regexp_replace(v_def, ' or coalesce\(nullif\(current_setting\(''role'', true\), ''''\), ''none''\) in \(''anon'', ''authenticated''\)(\s+then) /\*insert_role_guard\*/', '\1');
    execute v_def;
end $$;

commit;
