-- ============================================================
-- 환불 금액 정합성 보완(2026-10-17) — 검토용 초안, DEV/Production 미실행.
--
-- 선행(운영 적용 완료): fix_refund_pg_origin_guard_20261017.sql, fix_refund_server_path_fail_closed_20261017.sql (둘 중 하나라도 없으면 중단)
--
-- 발견한 문제
--  pg_refund_context() 는 PG 원거래 행을 우선해 결제키/금액을 돌려주고(앱 서버는 그 금액으로 PG 취소를 호출),
--  _refund_membership_core() 는 "가장 최근 payments 행"의 total_amount 를 환불 금액(v_amount)과 쿠폰/포인트 복원 대상 주문(v_order_id)으로 쓴다.
--  PG 원거래 이후에 수기·후속 결제 행이 생기면(또는 최근 행이 환불 행이면) 실제 PG 취소 금액과 내부 환불 기록 금액이 달라지고,
--  쿠폰/포인트 복원이 엉뚱한 주문(또는 NULL)에 대해 일어난다.
--
-- 수정(현재 운영 정의 제자리 패치, 함수 통째 덮어쓰기 금지)
--  [1] _refund_membership_core: PG 원거래 행(주문 연결·payments.payment_provider·결제키 중 하나로 식별, 금액>0, 환불 행 제외)이 있으면
--      v_amount / v_order_id 를 그 행의 값으로 정한다 → 내부 환불 기록 금액 = PG 원거래 금액 = (NICEPAY 라면) 취소 확인 기록의 cancel_amount.
--      PG 원거래 행이 2개 이상이거나, 이미 환불 행이 있는 PG 수강권이면 금액을 확정할 수 없으므로 거부(fail-closed, 운영자 수기 확인).
--      PG 원거래가 없는 수강권(직접결제·Mock)은 기존 계산(가장 최근 행) 그대로.
--  [2] pg_refund_context: 위와 같은 사유(원거래 2개 이상 / 이미 환불 행 존재)면 provider 를 'unknown_pg' 로 돌려 앱이 PG 취소 호출 전에 거부하게 한다
--      (PG는 취소했는데 DB가 거부하는 상황 방지).
--
-- 변경하지 않는 것: 데이터, 직접결제/Mock/수기 결제 환불, 연결된 Toss/PortOne 정상 환불(원거래 1건), 기존 가드들, 환불 행 INSERT 형태.
-- 롤백: rollback_fix_refund_amount_integrity_20261017.sql. 검증: verify_fix_refund_amount_integrity_20261017.sql(읽기 전용).
-- ============================================================
begin;

-- [1] _refund_membership_core
do $$
declare
    v_def text; v_n int; v_nl text;
    p_anchor text := '(v_amount\s*:=\s*coalesce\(\s*v_amount\s*,\s*0\s*\)\s*;)';
begin
    select pg_get_functiondef('public._refund_membership_core(uuid,uuid,boolean,boolean)'::regprocedure) into v_def;
    if v_def !~ '-- pg_unknown_origin_guard begin' or v_def !~ '-- pg_server_path_guard begin' then
        raise exception '_refund_membership_core 에 fix_refund_pg_origin_guard / fix_refund_server_path_fail_closed 패치가 없어요 — 먼저 적용하세요';
    end if;
    if v_def like '%-- pg_refund_amount begin%' then
        raise notice '_refund_membership_core: 이미 패치됨 — 건너뜀';
    else
        select count(*) into v_n from regexp_matches(v_def, p_anchor, 'g');
        if v_n <> 1 or v_def !~ 'v_mem' or v_def !~ 'v_order_id' then
            raise exception '_refund_membership_core 정의가 예상과 달라요(환불 금액 계산 위치 % — 1곳이어야 함) — 중단', v_n;
        end if;
        v_nl := case when position(chr(13) || chr(10) in v_def) > 0 then chr(13) || chr(10) else chr(10) end;
        v_def := regexp_replace(v_def, p_anchor,
            '\1' || v_nl || '    -- pg_refund_amount begin' || v_nl
            || '    if (select count(*) from payments pa left join orders oa on oa.id = pa.order_id' || v_nl
            || '         where pa.membership_id = v_mem.id and pa.sale_type is distinct from ''refund'' and pa.total_amount > 0' || v_nl
            || '           and ((oa.payment_provider is not null and oa.payment_provider <> ''mock'')' || v_nl
            || '                or (pa.payment_provider is not null and pa.payment_provider <> ''mock'')' || v_nl
            || '                or (pa.pg_transaction_id is not null and pa.pg_transaction_id not like ''mock!_%'' escape ''!''))) > 1 then' || v_nl
            || '        raise exception ''PG 결제 기록이 여러 개인 수강권은 환불 금액을 확정할 수 없어요. 운영자에게 문의해주세요'';' || v_nl
            || '    end if;' || v_nl
            || '    if exists (select 1 from payments pa left join orders oa on oa.id = pa.order_id' || v_nl
            || '                where pa.membership_id = v_mem.id and pa.sale_type is distinct from ''refund'' and pa.total_amount > 0' || v_nl
            || '                  and ((oa.payment_provider is not null and oa.payment_provider <> ''mock'')' || v_nl
            || '                       or (pa.payment_provider is not null and pa.payment_provider <> ''mock'')' || v_nl
            || '                       or (pa.pg_transaction_id is not null and pa.pg_transaction_id not like ''mock!_%'' escape ''!''))) then' || v_nl
            || '        if exists (select 1 from payments pr where pr.membership_id = v_mem.id and pr.sale_type = ''refund'') then' || v_nl
            || '            raise exception ''이미 환불 기록이 있는 PG 결제 수강권은 환불 금액을 확정할 수 없어요. 운영자에게 문의해주세요'';' || v_nl
            || '        end if;' || v_nl
            || '        v_amount := (select pa.total_amount from payments pa left join orders oa on oa.id = pa.order_id' || v_nl
            || '                      where pa.membership_id = v_mem.id and pa.sale_type is distinct from ''refund'' and pa.total_amount > 0' || v_nl
            || '                        and ((oa.payment_provider is not null and oa.payment_provider <> ''mock'')' || v_nl
            || '                             or (pa.payment_provider is not null and pa.payment_provider <> ''mock'')' || v_nl
            || '                             or (pa.pg_transaction_id is not null and pa.pg_transaction_id not like ''mock!_%'' escape ''!'')) limit 1);' || v_nl
            || '        v_order_id := (select pa.order_id from payments pa left join orders oa on oa.id = pa.order_id' || v_nl
            || '                        where pa.membership_id = v_mem.id and pa.sale_type is distinct from ''refund'' and pa.total_amount > 0' || v_nl
            || '                          and ((oa.payment_provider is not null and oa.payment_provider <> ''mock'')' || v_nl
            || '                               or (pa.payment_provider is not null and pa.payment_provider <> ''mock'')' || v_nl
            || '                               or (pa.pg_transaction_id is not null and pa.pg_transaction_id not like ''mock!_%'' escape ''!'')) limit 1);' || v_nl
            || '    end if;' || v_nl || '    -- pg_refund_amount end');
        execute v_def;
    end if;
end $$;

-- [2] pg_refund_context: 원거래 2개 이상 / 이미 환불 행이 있으면 'unknown_pg' (앱이 PG 취소 호출 전에 거부)
do $$
declare
    v_def text; v_n int; v_nl text;
    p_anchor text := '(-- pg_origin_context end)';
begin
    select pg_get_functiondef('public.pg_refund_context(uuid,uuid)'::regprocedure) into v_def;
    if v_def !~ '-- pg_origin_context begin' then
        raise exception 'pg_refund_context 에 fix_refund_server_path_fail_closed 패치가 없어요 — 먼저 적용하세요';
    end if;
    if v_def like '%-- pg_origin_ambiguity begin%' then
        raise notice 'pg_refund_context: 이미 패치됨 — 건너뜀';
        return;
    end if;
    select count(*) into v_n from regexp_matches(v_def, p_anchor, 'g');
    if v_n <> 1 then
        raise exception 'pg_refund_context 정의가 예상과 달라요(출처 판별 블록 끝 표지 %곳 — 1곳이어야 함) — 중단', v_n;
    end if;
    v_nl := case when position(chr(13) || chr(10) in v_def) > 0 then chr(13) || chr(10) else chr(10) end;
    v_def := regexp_replace(v_def, p_anchor,
        '\1' || v_nl || '    -- pg_origin_ambiguity begin' || v_nl
        || '    if v_provider is not null and v_provider <> ''unknown_pg'' and (' || v_nl
        || '        (select count(*) from payments pa left join orders oa on oa.id = pa.order_id' || v_nl
        || '          where pa.membership_id = v_mem.id and pa.sale_type is distinct from ''refund'' and pa.total_amount > 0' || v_nl
        || '            and ((oa.payment_provider is not null and oa.payment_provider <> ''mock'')' || v_nl
        || '                 or (pa.payment_provider is not null and pa.payment_provider <> ''mock'')' || v_nl
        || '                 or (pa.pg_transaction_id is not null and pa.pg_transaction_id not like ''mock!_%'' escape ''!''))) > 1' || v_nl
        || '        or exists (select 1 from payments pr where pr.membership_id = v_mem.id and pr.sale_type = ''refund'')) then' || v_nl
        || '        v_provider := ''unknown_pg'';' || v_nl
        || '    end if;' || v_nl || '    -- pg_origin_ambiguity end');
    execute v_def;
end $$;

commit;
