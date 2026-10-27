-- ============================================================
-- nicepay_claim_order 에 DB 게이트(mode) 검사 추가(2026-10-17, v8) — 검토용 초안, DEV/Production 미실행.
--
-- 배경: add_nicepay_checkout_gate(운영 적용 완료)의 mode='off'는 신규 주문 INSERT만 막는다. 이미 만들어진 NICEPAY 대기 주문이 있거나 mode를 off로 되돌린 뒤에도,
--   nicepay_claim_order(승인 선점)는 게이트를 보지 않아 앱 잠금(서버 코드)만이 승인 호출을 막았다. → 선점 단계에서도 DB 게이트를 검사한다.
-- 동작: off → null(선점 거부, PG 승인 호출 없음) / reviewer → 주문 소유 프로필의 계정이 pg_checkout_override 일 때만 / public → 허용.
--   이미 approving 인 주문의 이후 단계(승인 기록·확정·PG 취소 기록·release·검토·수동 해소·환불)는 게이트를 보지 않는다 → off 전환 후에도 진행 중 거래를 안전하게 마무리(취소·복구)할 수 있다.
-- 호환: 운영에 이미 적용된 게이트(nicepay_checkout_mode())를 그대로 사용한다. 게이트 SQL은 변경하지 않는다.
-- 적용 대상: add_nicepay_provider_support 가 **이미 적용된** DB 의 nicepay_claim_order 현재 정의를 제자리 패치(정확히 1곳, 멱등).
--   · 지원 SQL 이 아직 적용 전이면(운영 현재 상태) 아무것도 하지 않는다 — 새 버전의 add_nicepay_provider_support 가 같은 검사를 이미 포함한다.
--   · 이미 포함돼 있으면(마커 있음) 건너뜀.
-- 롤백: rollback_fix_nicepay_claim_gate_20261017.sql. 검증: verify_fix_nicepay_claim_gate_20261017.sql(읽기 전용).
-- ============================================================
begin;

do $$
declare
    v_def text; v_n1 int; v_n2 int; v_nl text;
    p_decl text := '(v_claim\s+uuid\s*;)';
    p_body text := '(begin)(\s+)(perform\s+set_config\(\s*''app\.nicepay_write''\s*,\s*''on''\s*,\s*true\s*\)\s*;)';
begin
    if to_regprocedure('public.nicepay_checkout_mode()') is null then
        raise exception 'nicepay_checkout_mode() 가 없어요 — add_nicepay_checkout_gate_20261017.sql 이 먼저 필요해요';
    end if;
    if to_regprocedure('public.nicepay_claim_order(uuid)') is null then
        raise notice 'nicepay_claim_order 가 아직 없어요(add_nicepay_provider_support 미적용) — 새 버전의 지원 SQL 이 같은 검사를 포함하므로 건너뜀';
        return;
    end if;
    select pg_get_functiondef('public.nicepay_claim_order(uuid)'::regprocedure) into v_def;
    if v_def like '%-- nicepay_claim_gate begin%' then
        raise notice 'nicepay_claim_order: 이미 게이트 검사 포함 — 건너뜀';
        return;
    end if;
    select count(*) into v_n1 from regexp_matches(v_def, p_decl, 'g');
    select count(*) into v_n2 from regexp_matches(v_def, p_body, 'g');
    if v_n1 <> 1 or v_n2 <> 1 or v_def !~ 'pg_claim_id' or v_def !~ 'status\s*=\s*''approving''' then
        raise exception 'nicepay_claim_order 정의가 예상과 달라요(선언 %곳 / 본문 시작 %곳 — 각 1곳이어야 함) — 중단', v_n1, v_n2;
    end if;
    v_nl := case when position(chr(13) || chr(10) in v_def) > 0 then chr(13) || chr(10) else chr(10) end;
    v_def := regexp_replace(v_def, p_decl, '\1 /*claim_gate*/ v_mode text;');
    v_def := regexp_replace(v_def, p_body,
        '\1\2-- nicepay_claim_gate begin' || v_nl
        || '    -- DB 게이트: 신규 승인 선점은 모드가 허용할 때만. off=거부 / reviewer=심사 계정(accounts.pg_checkout_override) 주문만 / public=허용. 거부는 null(= 선점 못 함, PG 승인 호출 없음).' || v_nl
        || '    -- 이미 approving 인 주문의 이후 단계(승인 기록·확정·취소 기록·release·검토·수동 해소·환불)는 이 게이트를 보지 않는다 → off 전환 후에도 진행 중 거래는 안전하게 마무리된다.' || v_nl
        || '    v_mode := nicepay_checkout_mode();' || v_nl
        || '    if v_mode is distinct from ''public'' and not (v_mode = ''reviewer'' and exists (' || v_nl
        || '           select 1 from orders go join profiles gp on gp.id = go.profile_id join accounts ga on ga.id = gp.account_id' || v_nl
        || '            where go.id = p_order_id and ga.pg_checkout_override)) then' || v_nl
        || '        return null;' || v_nl
        || '    end if;' || v_nl || '    -- nicepay_claim_gate end' || v_nl || '    ' || '\3');
    execute v_def;
end $$;

commit;
