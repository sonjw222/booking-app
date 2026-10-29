-- 롤백: 서버 환불 경로 fail-closed 가드와 pg_refund_context 출처 판별 보완을 제거하고 원문 그대로 복원한다.
begin;

do $$
declare
    v_def text;
begin
    select pg_get_functiondef('public._refund_membership_core(uuid,uuid,boolean,boolean)'::regprocedure) into v_def;
    v_def := regexp_replace(v_def, '\r?\n[ \t]*-- pg_server_path_guard begin.*?-- pg_server_path_guard end', '', 's');
    execute v_def;

    select pg_get_functiondef('public.pg_refund_context(uuid,uuid)'::regprocedure) into v_def;
    v_def := regexp_replace(v_def, '\r?\n[ \t]*-- pg_origin_context begin.*?-- pg_origin_context end', '', 's');
    v_def := regexp_replace(v_def, '(v_provider\s+text\s*;) /\*pg_origin_context\*/ v_org record;', '\1');
    execute v_def;
end $$;

commit;
