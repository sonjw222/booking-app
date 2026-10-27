-- 롤백: 일반 환불 PG 판별/출처 불명확 차단 패치를 제거하고 원래 조건('toss','portone' 목록)을 원문 그대로 복원한다.
-- ⚠ 롤백하면 order_id 연결 없는 PG 결제 건의 일반 환불 우회가 다시 가능해진다.
begin;

do $$
declare
    v_def text;
begin
    select pg_get_functiondef('public._refund_membership_core(uuid,uuid,boolean,boolean)'::regprocedure) into v_def;
    v_def := regexp_replace(v_def, '\r?\n[ \t]*-- pg_unknown_origin_guard begin.*?-- pg_unknown_origin_guard end', '', 's');
    v_def := regexp_replace(v_def, '(o\.payment_provider) is not null and o\.payment_provider <> ''mock'' /\*was:(.*?)\*/', '\1\2', 's');
    execute v_def;
end $$;

commit;
