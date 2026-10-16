-- ============================================================
-- create_order_secure()의 허용 provider 목록에 'nicepay' 추가(2026-10-16) — 검토용 초안, DEV/Production 미실행.
--
-- 운영 DB 실측: public.create_order_secure(uuid, text, text, integer, boolean, text) 가 존재하고 허용 provider는 mock, toss, portone 이다.
-- 이 함수의 정의는 저장소에 없다(라이브 전용). 따라서 함수를 통째로 덮어쓰지 않고, 현재 정의를 pg_get_functiondef()로 읽어
-- 'mock','toss','portone' 목록이 **정확히 1곳**일 때만 그 목록 뒤에 'nicepay'를 붙인다(줄바꿈 CRLF/LF·공백 무관).
-- 목록이 0곳이거나 2곳 이상이면(예: 검증이 두 군데) 예외로 중단 — 아무것도 바꾸지 않는다. 이미 'nicepay'가 있으면 건너뛴다(멱등).
-- 프로필 선택·상품 검증·포인트 차감·금액 검증·주문 생성 로직은 건드리지 않는다. 시그니처/SECURITY DEFINER/search_path/권한 불변(create or replace).
--
-- 선행: add_nicepay_provider_support_20261016.sql (orders.payment_provider CHECK에 nicepay가 있어야 한다 — 없으면 중단).
-- 순서: fix_refund_pg_origin_guard_20261017.sql → add_nicepay_provider_support_20261016.sql → 이 파일.
-- 롤백: rollback_fix_create_order_secure_allow_nicepay_20261016.sql. 사전 확인(읽기 전용): preflight_nicepay_patch_targets_20261016.sql.
-- ============================================================
begin;

do $$
declare
    v_def text; v_n int;
    p text := '(''mock''\s*,\s*''toss''\s*,\s*''portone'')';
begin
    if to_regprocedure('public.create_order_secure(uuid,text,text,integer,boolean,text)') is null then
        raise exception 'public.create_order_secure(uuid,text,text,integer,boolean,text) 가 없어요 — 중단';
    end if;
    if not exists (select 1 from pg_constraint where conname = 'orders_payment_provider_check' and pg_get_constraintdef(oid) like '%nicepay%') then
        raise exception 'orders_payment_provider_check 에 nicepay가 없어요 — add_nicepay_provider_support_20261016.sql 을 먼저 적용하세요';
    end if;
    select pg_get_functiondef('public.create_order_secure(uuid,text,text,integer,boolean,text)'::regprocedure) into v_def;
    if v_def ~ '''portone''\s*,\s*''nicepay''' then
        raise notice 'create_order_secure: 이미 nicepay 포함 — 건너뜀';
        return;
    end if;
    select count(*) into v_n from regexp_matches(v_def, p, 'g');
    if v_n <> 1 then
        raise exception 'create_order_secure 의 provider 목록(mock, toss, portone)이 % 곳이에요(1곳이어야 함) — 중단', v_n;
    end if;
    execute regexp_replace(v_def, p, '\1, ''nicepay''');
end $$;

commit;
