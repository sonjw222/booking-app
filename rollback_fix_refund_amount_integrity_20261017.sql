-- 롤백: 환불 금액 정합성 보완을 제거하고 직전(서버 경로 fail-closed 적용 상태) 원문 그대로 복원한다.
begin;

do $$
declare
    v_def text;
begin
    select pg_get_functiondef('public._refund_membership_core(uuid,uuid,boolean,boolean)'::regprocedure) into v_def;
    v_def := regexp_replace(v_def, '\r?\n[ \t]*-- pg_refund_amount begin.*?-- pg_refund_amount end', '', 's');
    execute v_def;

    select pg_get_functiondef('public.pg_refund_context(uuid,uuid)'::regprocedure) into v_def;
    v_def := regexp_replace(v_def, '\r?\n[ \t]*-- pg_origin_ambiguity begin.*?-- pg_origin_ambiguity end', '', 's');
    execute v_def;
end $$;

commit;
