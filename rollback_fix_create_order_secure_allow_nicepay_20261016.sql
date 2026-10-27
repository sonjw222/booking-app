-- 롤백: create_order_secure 의 provider 목록에서 'nicepay'를 제거(정확히 역치환). nicepay 주문이 있으면 중단.
begin;

do $$
declare
    v_def text;
begin
    if exists (select 1 from orders where payment_provider = 'nicepay') then
        raise exception 'nicepay 주문이 있어 롤백하지 않습니다';
    end if;
    select pg_get_functiondef('public.create_order_secure(uuid,text,text,integer,boolean,text)'::regprocedure) into v_def;
    execute regexp_replace(v_def, '(''mock''\s*,\s*''toss''\s*,\s*''portone''), ''nicepay''', '\1');
end $$;

commit;
