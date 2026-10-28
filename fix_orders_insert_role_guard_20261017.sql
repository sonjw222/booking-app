-- ============================================================
-- orders INSERT 서버 전용 필드 보정의 anon/authenticated 역할 경계 보완(2026-10-17) — 검토용 초안, DEV/Production 미실행.
--
-- 배경: orders_force_server_fields_on_insert()는 `auth.uid() is not null`일 때만 verified=false / status='pending' / paid_at=null 로 보정한다("service_role/서버 작업은 JWT sub가 없다"는 전제).
--   그런데 anon 롤(로그인 안 한 PostgREST 요청)도 JWT sub가 없어 auth.uid()가 NULL이다 → 이 트리거는 anon INSERT를 "서버 작업"으로 취급해 보정하지 않는다.
--   현재는 RLS 정책("주문 본인 생성": profile_id in my_profile_ids())이 anon에게 0행이라 실제로 뚫려 있지 않지만, 정책/권한이 실수로 넓어지면(예: 새 정책, 잘못된 GRANT) anon이
--   verified=true, status='done' 주문을 직접 만들 수 있다 → 방어 계층이 없다. (orders_guard_pg_state는 add_nicepay_provider_support에서 같은 경계를 이미 좁혔다.)
-- 수정: 보정 조건을 `auth.uid() is not null OR 요청 롤이 anon/authenticated`로 넓힌다. current_setting('role')은 PostgREST가 SET ROLE 한 값(anon/authenticated/service_role)이며
--   SECURITY DEFINER 함수 안에서도 호출 세션의 값을 유지한다. 서버 작업(service_role, 롤 미설정 'none'인 소유자/마이그레이션/pg_cron 세션)은 이전과 동일하게 보정하지 않는다.
-- 변경하지 않는 것: 데이터, 로그인 사용자(uid 있음)의 동작(이미 보정됨), service_role/서버 주문 생성, 트리거 정의, 다른 함수. 직접결제·Mock·Toss·NICEPAY 주문 생성 흐름은 모두 로그인 사용자 또는 service_role이라 영향 없음.
-- 방식: 현재 운영 함수 정의(pg_get_functiondef)를 읽어 정확히 1곳만 제자리 패치. 위치가 1곳이 아니면 중단, 이미 패치됐으면 건너뜀(멱등).
-- 롤백: rollback_fix_orders_insert_role_guard_20261017.sql. 검증: verify_fix_orders_insert_role_guard_20261017.sql(읽기 전용).
-- ============================================================
begin;

do $$
declare
    v_def text; v_n int;
    p_pred text := '(if\s+auth\.uid\(\)\s+is\s+not\s+null)(\s+then)';
begin
    select pg_get_functiondef('public.orders_force_server_fields_on_insert()'::regprocedure) into v_def;
    if v_def like '%/*insert_role_guard*/%' then
        raise notice 'orders_force_server_fields_on_insert: 이미 패치됨 — 건너뜀';
        return;
    end if;
    select count(*) into v_n from regexp_matches(v_def, p_pred, 'g');
    if v_n <> 1 or v_def !~ 'new\.verified\s*:=\s*false' or v_def !~ 'new\.status\s*:=\s*''pending''' then
        raise exception 'orders_force_server_fields_on_insert 정의가 예상과 달라요(조건 위치 % — 1곳이어야 함) — 중단', v_n;
    end if;
    v_def := regexp_replace(v_def, p_pred,
        '\1 or coalesce(nullif(current_setting(''role'', true), ''''), ''none'') in (''anon'', ''authenticated'')\2 /*insert_role_guard*/');
    execute v_def;
end $$;

commit;
