-- ============================================================
-- 서버 환불 경로(p_allow_pg=true)의 fail-closed 보완 + pg_refund_context 의 PG 출처 판별 보완(2026-10-17) — 검토용 초안, DEV/Production 미실행.
--
-- 선행(운영 적용 완료): fix_refund_pg_origin_guard_20261017.sql  (이 파일은 그 위에 얹는 제자리 패치. 없으면 중단한다.)
--
-- 발견한 문제
--  A. NICEPAY 취소 확인 가드(add_nicepay_provider_support_20261016.sql [6-4])가 `v_order_id is not null and v_amount > 0` 에 의존했다.
--     v_order_id/v_amount 는 "가장 최근 payments 행" 기준이라, 최근 행의 order_id 가 NULL(후속 수기 결제 행, 연결이 끊긴 결제)이면
--     p_allow_pg=true 인 서버 환불 경로(refund_membership_server)에서 PG 취소 확인 검사가 생략된다. → add_nicepay_provider_support 의 [6-4]를 v2로 교체(같은 PR의 파일).
--  B. 일반환불 PG 판별은 p_allow_pg=false(회원 경로)에서만 동작한다. 출처가 불명확한 PG 결제(연결 없는 Toss 등)를 서버 경로(p_allow_pg=true)로 환불할 때
--     아무 표시 없이 통과한다. → 환불 진행 표시(pg_refund_begin 이 거는 memberships.pg_refund_started_at) 없이는 서버 경로로도 환불 불가.
--     (NICEPAY 행(payments.payment_provider='nicepay')은 더 강한 증거인 PG 취소 확인 기록으로 막으므로 여기서 제외한다.
--      연결된 Toss/PortOne 은 기존 서버 흐름 그대로: begin → PG 취소 → 환불. 이미 표시가 있거나, '이미 PG 취소됨' 복구 흐름이 있어 여기서는 요구하지 않는다.)
--  C. pg_refund_context() 가 "가장 최근 payments 행"의 order_id 로만 provider/결제키를 정해, 최근 행이 수기 결제이거나 order_id 가 NULL 이면 provider=null(직접결제)로
--     오판한다. → PG 원거래 행(주문 연결·payment_provider·결제키 중 하나로 식별)을 우선해 provider/결제키/금액을 돌려주고, 식별은 되지만 provider 를 알 수 없으면
--     'unknown_pg' 를 돌려준다(앱 서버 handleRefund 는 알 수 없는 PG 의 금액>0 환불을 501 로 거부).
--
-- 방식: 운영 DB의 현재 함수 정의(pg_get_functiondef)를 읽어 정확히 1곳씩만 제자리 패치(함수 통째 덮어쓰기 금지). 위치가 1곳이 아니면 예외로 중단, 이미 패치됐으면 건너뜀(멱등).
-- 변경하지 않는 것: 데이터, 직접결제/Mock/수기 결제 환불, 연결된 Toss/PortOne 서버 환불 흐름, 기존 일반환불 차단.
-- 롤백: rollback_fix_refund_server_path_fail_closed_20261017.sql. 검증: verify_fix_refund_server_path_fail_closed_20261017.sql(읽기 전용).
-- ============================================================
begin;

-- [1] _refund_membership_core: 출처 불명확 PG 결제의 서버 경로는 환불 진행 표시가 있어야 한다
do $$
declare
    v_def text; v_n int; v_nl text;
    p_anchor text := '(raise\s+exception\s+''카드/간편결제로 결제한 수강권은 앱의 환불 요청 기능으로 환불해주세요''\s*;\s*end\s+if;)';
begin
    select pg_get_functiondef('public._refund_membership_core(uuid,uuid,boolean,boolean)'::regprocedure) into v_def;
    if v_def !~ '-- pg_unknown_origin_guard begin' then
        raise exception '_refund_membership_core 에 fix_refund_pg_origin_guard_20261017 패치가 없어요 — 먼저 적용하세요';
    end if;
    if v_def like '%-- pg_server_path_guard begin%' then
        raise notice '_refund_membership_core: 이미 패치됨 — 건너뜀';
    else
        select count(*) into v_n from regexp_matches(v_def, p_anchor, 'g');
        if v_n <> 1 or v_def !~ 'v_mem' then
            raise exception '_refund_membership_core 정의가 예상과 달라요(일반환불 차단 위치 % — 1곳이어야 함) — 중단', v_n;
        end if;
        v_nl := case when position(chr(13) || chr(10) in v_def) > 0 then chr(13) || chr(10) else chr(10) end;
        v_def := regexp_replace(v_def, p_anchor,
            '\1' || v_nl || '    -- pg_server_path_guard begin' || v_nl
            || '    if coalesce(p_allow_pg, false) and v_mem.pg_refund_started_at is null' || v_nl
            || '       and not exists (select 1 from payments pa join orders oa on oa.id = pa.order_id' || v_nl
            || '                        where pa.membership_id = v_mem.id and oa.payment_provider is not null and oa.payment_provider <> ''mock'')' || v_nl
            || '       and (exists (select 1 from payments pb where pb.membership_id = v_mem.id and pb.sale_type is distinct from ''refund'' and pb.total_amount > 0' || v_nl
            || '                     and pb.payment_provider is distinct from ''nicepay''' || v_nl
            || '                     and ((pb.payment_provider is not null and pb.payment_provider <> ''mock'')' || v_nl
            || '                          or (pb.pg_transaction_id is not null and pb.pg_transaction_id not like ''mock!_%'' escape ''!'')))' || v_nl
            || '            or exists (select 1 from orders oc where oc.profile_id = v_mem.profile_id and oc.center_id = v_mem.center_id and oc.product_id = v_mem.product_id' || v_nl
            || '                        and oc.status = ''done'' and oc.amount > 0 and oc.payment_provider is not null and oc.payment_provider not in (''mock'', ''nicepay'')' || v_nl
            || '                        and not exists (select 1 from payments pc where pc.order_id = oc.id))) then' || v_nl
            || '        raise exception ''PG 결제 출처를 확인할 수 없는 수강권은 환불 진행 표시(pg_refund_begin) 없이 서버 경로로 환불할 수 없어요'';' || v_nl
            || '    end if;' || v_nl || '    -- pg_server_path_guard end');
        execute v_def;
    end if;
end $$;

-- [2] pg_refund_context: PG 원거래 행 기준으로 provider/결제키/금액을 돌려주고, 출처 불명확하면 'unknown_pg'
do $$
declare
    v_def text; v_n1 int; v_n2 int; v_nl text;
    p_decl  text := '(v_provider\s+text\s*;)';
    p_block text := '(if\s+v_pay\.order_id\s+is\s+not\s+null\s+then\s+select\s+payment_provider\s+into\s+v_provider\s+from\s+orders\s+where\s+id\s*=\s*v_pay\.order_id\s*;\s*end\s+if;)';
begin
    select pg_get_functiondef('public.pg_refund_context(uuid,uuid)'::regprocedure) into v_def;
    if v_def like '%-- pg_origin_context begin%' then
        raise notice 'pg_refund_context: 이미 패치됨 — 건너뜀';
        return;
    end if;
    select count(*) into v_n1 from regexp_matches(v_def, p_decl, 'g');
    select count(*) into v_n2 from regexp_matches(v_def, p_block, 'g');
    if v_n1 <> 1 or v_n2 <> 1 or v_def !~ 'v_pay' or v_def !~ 'v_mem' then
        raise exception 'pg_refund_context 정의가 예상과 달라요(선언 %곳 / provider 판별 블록 %곳 — 각 1곳이어야 함) — 중단', v_n1, v_n2;
    end if;
    v_nl := case when position(chr(13) || chr(10) in v_def) > 0 then chr(13) || chr(10) else chr(10) end;
    v_def := regexp_replace(v_def, p_decl, '\1 /*pg_origin_context*/ v_org record;');
    v_def := regexp_replace(v_def, p_block,
        '\1' || v_nl || '    -- pg_origin_context begin' || v_nl
        || '    select pa.order_id, pa.total_amount, pa.pg_transaction_id,' || v_nl
        || '           case when oa.payment_provider is not null and oa.payment_provider <> ''mock'' then oa.payment_provider' || v_nl
        || '                when pa.payment_provider is not null and pa.payment_provider <> ''mock'' then pa.payment_provider' || v_nl
        || '                else ''unknown_pg'' end as prov' || v_nl
        || '      into v_org' || v_nl
        || '      from payments pa left join orders oa on oa.id = pa.order_id' || v_nl
        || '     where pa.membership_id = v_mem.id and pa.sale_type is distinct from ''refund''' || v_nl
        || '       and ((oa.payment_provider is not null and oa.payment_provider <> ''mock'')' || v_nl
        || '            or (pa.payment_provider is not null and pa.payment_provider <> ''mock'')' || v_nl
        || '            or (pa.pg_transaction_id is not null and pa.pg_transaction_id not like ''mock!_%'' escape ''!''))' || v_nl
        || '     order by case when oa.payment_provider is not null and oa.payment_provider <> ''mock'' then 0 else 1 end, pa.paid_at desc' || v_nl
        || '     limit 1;' || v_nl
        || '    if found then' || v_nl
        || '        v_pay := v_org;' || v_nl
        || '        v_provider := v_org.prov;' || v_nl
        || '    elsif exists (select 1 from orders oc where oc.profile_id = v_mem.profile_id and oc.center_id = v_mem.center_id and oc.product_id = v_mem.product_id' || v_nl
        || '                   and oc.status = ''done'' and oc.amount > 0 and oc.payment_provider is not null and oc.payment_provider <> ''mock''' || v_nl
        || '                   and not exists (select 1 from payments pc where pc.order_id = oc.id)) then' || v_nl
        || '        v_provider := ''unknown_pg'';' || v_nl
        || '    end if;' || v_nl || '    -- pg_origin_context end');
    execute v_def;
end $$;

commit;
