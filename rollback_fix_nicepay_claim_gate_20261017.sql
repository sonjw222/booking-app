-- 롤백: nicepay_claim_order 의 DB 게이트 검사 제거(표지 구간과 v_mode 선언만 제거해 직전 형태로 복원). 함수가 없으면 아무것도 하지 않는다.
begin;
do $$
declare
    v_def text;
begin
    if to_regprocedure('public.nicepay_claim_order(uuid)') is null then
        raise notice 'nicepay_claim_order 가 없어요 — 건너뜀';
        return;
    end if;
    select pg_get_functiondef('public.nicepay_claim_order(uuid)'::regprocedure) into v_def;
    v_def := regexp_replace(v_def, '\r?\n[ \t]*-- nicepay_claim_gate begin.*?-- nicepay_claim_gate end', '', 's');
    v_def := regexp_replace(v_def, '(v_claim\s+uuid\s*;) /\*claim_gate\*/ v_mode text;', '\1');
    execute v_def;
end $$;
commit;
