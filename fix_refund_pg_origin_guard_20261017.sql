-- ============================================================
-- 일반 환불의 PG 우회 차단 강화(2026-10-17) — 검토용 초안, DEV/Production 미실행.
-- (2026-10-16 fix_refund_block_all_pg_providers_20261016.sql 을 대체한다. 그 파일은 함수 전체를 저장소 정의로 덮어쓰는 방식이라 폐기.)
--
-- 운영 실측(읽기 전용): Toss 완료 주문 3건 중 연결된 결제 기록은 2건. 32만 원 완료 주문 1건은 payments.order_id 연결이 없고,
--   같은 회원·센터·상품의 수강권과 환불 기록이 있다. payments.order_id 는 nullable(`references orders(id) on delete set null`)이다.
-- 우회 경로: _refund_membership_core 는 "해당 수강권의 가장 최근 payments 행"의 order_id 로 주문 provider 를 찾아 PG 여부를 판단한다.
--   order_id 가 NULL 이면(연결 없는 과거 PG 결제, 주문 삭제로 SET NULL 된 행, 또는 PG 결제 뒤에 수기 결제 행이 더 최근에 추가된 경우)
--   `v_order_id is not null and exists (...)` 가 거짓이 되어 회원이 refund_membership RPC 로 PG 결제 건을 외부 취소 없이 DB 에서만 환불할 수 있다.
--
-- 이 파일은 "운영 DB의 현재 환불 함수 정의"를 기준으로 제자리(in-place) 패치한다(함수를 통째로 덮어쓰지 않는다 — 이미 적용된 정의를 과거 버전으로 되돌리지 않음).
--  ① PG 판별을 허용 목록으로: payment_provider 가 NULL(직접결제)도 'mock'도 아니면 PG (기존 'toss','portone' 목록은 'was' 주석으로 보존 → 롤백 시 원문 복원)
--  ② PG 출처가 불명확한 수강권의 일반 환불 차단(앱 회원 경로 p_allow_pg=false 만; 서버 경로 p_allow_pg=true 는 영향 없음):
--     (a) 이 수강권의 결제 기록 중 어느 하나라도 PG 주문과 연결됨(가장 최근 행만 보던 허점 제거)
--     (b) 이 수강권의 매출 기록 중 payment_provider 가 PG 이거나 pg_transaction_id 가 있음('mock_' 접두 제외)
--     (c) 같은 회원·센터·상품에 결제 기록이 하나도 연결되지 않은 PG 완료 주문이 있음(= 출처를 확인할 수 없는 PG 결제가 존재)
--  정상 직접결제(NULL)·Mock('mock')·수기 입력 결제는 (a)(b)(c)에 걸리지 않아 기존대로 환불된다.
-- 하지 않는 것: 주문 자동 연결, 과거 결제 데이터 추정 백필, 데이터 변경. 불명확하면 차단만 한다(운영자가 PG 콘솔에서 확인 후 서버 경로/수동 처리).
-- 안전: 위치가 정확히 1곳이 아니면(예상과 다른 함수 구조) 예외로 중단. 이미 패치됐으면 건너뜀(멱등). add_nicepay_provider_support 와 적용 순서 무관.
-- 롤백: rollback_fix_refund_pg_origin_guard_20261017.sql. 검증: verify_fix_refund_pg_origin_guard_20261017.sql(읽기 전용).
-- ============================================================
begin;

do $$
declare
    v_def text; v_n int; v_nl text; v_has_pred boolean;
    p_anchor text := '(raise\s+exception\s+''카드/간편결제로 결제한 수강권은 앱의 환불 요청 기능으로 환불해주세요''\s*;\s*end\s+if;)';
    p_pred   text := '(o\.payment_provider)(\s+in\s*\(\s*''toss''\s*,\s*''portone''\s*\))';
begin
    select pg_get_functiondef('public._refund_membership_core(uuid,uuid,boolean,boolean)'::regprocedure) into v_def;
    if v_def like '%-- pg_unknown_origin_guard begin%' then
        raise notice '_refund_membership_core: 이미 패치됨 — 건너뜀';
        return;
    end if;
    select count(*) into v_n from regexp_matches(v_def, p_anchor, 'g');
    if v_n <> 1 or v_def !~ 'v_mem' or v_def !~ 'p_allow_pg' then
        raise exception '_refund_membership_core 정의가 예상과 달라요(일반환불 차단 위치 % — 1곳이어야 함) — 중단', v_n;
    end if;
    -- ① 허용 목록 (이미 허용 목록이면 그대로, 옛 'toss','portone' 목록이면 정확히 1곳만 교체)
    select count(*) into v_n from regexp_matches(v_def, p_pred, 'g');
    v_has_pred := v_def ~ 'o\.payment_provider is not null and o\.payment_provider <> ''mock''';
    if v_n = 1 and not v_has_pred then
        v_def := regexp_replace(v_def, p_pred, '\1 is not null and o.payment_provider <> ''mock'' /*was:\2*/');
    elsif not (v_n = 0 and v_has_pred) then
        raise exception '_refund_membership_core 의 PG 판별 조건이 예상과 달라요 — 중단';
    end if;
    -- ② PG 출처 불명확 차단 블록
    v_nl := case when position(chr(13) || chr(10) in v_def) > 0 then chr(13) || chr(10) else chr(10) end;
    v_def := regexp_replace(v_def, p_anchor,
        '\1' || v_nl || '    -- pg_unknown_origin_guard begin' || v_nl
        || '    if not coalesce(p_allow_pg, false) and (' || v_nl
        || '        exists (select 1 from payments pa join orders oa on oa.id = pa.order_id' || v_nl
        || '                 where pa.membership_id = v_mem.id and oa.payment_provider is not null and oa.payment_provider <> ''mock'')' || v_nl
        || '        or exists (select 1 from payments pb where pb.membership_id = v_mem.id and pb.sale_type is distinct from ''refund''' || v_nl
        || '                    and ((pb.payment_provider is not null and pb.payment_provider <> ''mock'')' || v_nl
        || '                         or (pb.pg_transaction_id is not null and pb.pg_transaction_id not like ''mock!_%'' escape ''!'')))' || v_nl
        || '        or exists (select 1 from orders oc where oc.profile_id = v_mem.profile_id and oc.center_id = v_mem.center_id and oc.product_id = v_mem.product_id' || v_nl
        || '                    and oc.status = ''done'' and oc.payment_provider is not null and oc.payment_provider <> ''mock''' || v_nl
        || '                    and not exists (select 1 from payments pc where pc.order_id = oc.id))' || v_nl
        || '    ) then' || v_nl
        || '        raise exception ''PG 결제 출처를 확인할 수 없는 수강권은 앱에서 환불할 수 없어요. 센터 또는 운영자에게 문의해주세요'';' || v_nl
        || '    end if;' || v_nl || '    -- pg_unknown_origin_guard end');
    execute v_def;
end $$;

commit;
