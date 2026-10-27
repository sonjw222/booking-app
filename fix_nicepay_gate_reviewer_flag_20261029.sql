-- ============================================================
-- NICEPAY 결제 게이트의 "심사관" 판별을 전용 권한(accounts.nicepay_review_access)으로 변경(2026-10-29) — 검토용 초안, 운영 미실행.
--
-- 배경: 운영에 이미 적용된 두 함수가 mode='reviewer' 일 때 심사관을 accounts.pg_checkout_override(토스 심사용)로 판별한다.
--   · orders_guard_nicepay_create()  — 20261017134256_add_nicepay_checkout_gate_20261017 (NICEPAY 대기 주문 생성 트리거)
--   · nicepay_claim_order(uuid)      — 20261017151331_add_nicepay_provider_support_20261016_v8 (승인 선점)
--   NICEPAY 전용 권한을 분리하면(B안) 토스 심사 계정(override=true)이 실제 센터에서 NICEPAY 주문을 만들 수 있는 구멍이 남는다 → 두 함수의 판별을 새 권한으로 바꾼다.
-- 방식: 운영의 현재 함수 정의(pg_get_functiondef)를 읽어 `pg_checkout_override` 를 `nicepay_review_access` 로 제자리 치환(함수 통째 덮어쓰기 금지).
--   치환 위치가 예상(코드 1곳 이상, 총 3곳 이하)이 아니면 예외로 중단, 이미 바뀌었으면 건너뜀(멱등). 다른 로직은 한 글자도 바꾸지 않는다.
-- 전제: add_nicepay_review_center_isolation_20261028.sql 이 먼저 적용돼 accounts.nicepay_review_access 가 있어야 한다(없으면 중단).
-- 영향: mode 가 'off'(현재 기본)이면 동작 차이 없음. 'reviewer' 모드에서 NICEPAY 주문 생성·승인 선점이 nicepay_review_access 계정에만 허용된다. 'public' 모드는 영향 없음.
-- 롤백: rollback_fix_nicepay_gate_reviewer_flag_20261029.sql(역치환). 검증: verify_fix_nicepay_gate_reviewer_flag_20261029.sql(읽기 전용).
-- ============================================================
begin;
do $$
declare
    v_sig text; v_def text; v_new text; v_n int; v_code int;
begin
    if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='accounts' and column_name='nicepay_review_access') then
        raise exception 'accounts.nicepay_review_access 가 없어요 — add_nicepay_review_center_isolation_20261028.sql 을 먼저 적용하세요';
    end if;
    foreach v_sig in array array['public.orders_guard_nicepay_create()', 'public.nicepay_claim_order(uuid)'] loop
        if to_regprocedure(v_sig) is null then raise exception '% 가 없어요 — NICEPAY 게이트/지원 SQL 이 적용돼 있어야 해요', v_sig; end if;
        select pg_get_functiondef(to_regprocedure(v_sig)) into v_def;
        v_n := (length(v_def) - length(replace(v_def, 'pg_checkout_override', ''))) / length('pg_checkout_override');
        v_code := (length(v_def) - length(replace(v_def, '.pg_checkout_override', ''))) / length('.pg_checkout_override');
        if v_n = 0 and position('nicepay_review_access' in v_def) > 0 then raise notice '%: 이미 전용 권한으로 바뀜 — 건너뜀', v_sig; continue; end if;
        if v_code < 1 or v_n > 3 then raise exception '% 정의가 예상과 달라요(pg_checkout_override 총 %곳 / 코드 %곳) — 중단', v_sig, v_n, v_code; end if;
        v_new := replace(v_def, 'pg_checkout_override', 'nicepay_review_access');
        execute v_new;
    end loop;
end $$;
commit;
