-- ============================================================
-- 실 PG 결제 서버 라이프사이클 보완 (2026-10-02)
--
-- [감사 결과(Production 라이브 정의 기준)]
--   · confirm_test_payment(): anon/authenticated 모두 실행 가능. 본인 주문이면 payment_provider='mock'만 확인하고
--     _issue_membership_and_record_payment()로 수강권 + 결제(paid) 기록을 만든다. orders INSERT RLS는 payment_provider/verified/status를
--     제한하지 않으므로, 로그인한 회원이 provider='mock' 주문을 직접 만든 뒤 이 RPC를 호출하면 "결제 없이" 수강권이 발급된다(금액 검증은 통과).
--     → 내부 QA 센터(centers.is_internal)에서만 Mock 확정을 허용한다.
--   · orders.verified: 회원이 INSERT 시 true로 줄 수 있고, fulfill_order는 verified=true면 금액 재검증을 건너뛴다 → 회원 INSERT는 verified=false/pending으로 고정.
--   · refund_membership(): 브라우저가 직접 호출 — 실제 PG(toss/portone) 결제 주문도 DB 환불만 하고 토스 승인 취소는 하지 않는다 → 서버 전용 경로로 이전.
--     브라우저 호출은 PG 주문이면 거부(DB 가드). 환불 로직은 공통 core 함수로 옮겨 라이브 정의와 동일하게 유지(조건/매출/쿠폰/포인트/회원상태).
--   · cancel_real_payment / _issue_membership_and_record_payment: SECURITY DEFINER인데 search_path 미고정 → 고정(ALTER만, 본문 불변).
--
-- [이 migration]
--   1) search_path 고정: cancel_real_payment, _issue_membership_and_record_payment.
--   2) confirm_test_payment: 내부 QA 센터에서만 + anon 실행 차단(라이브 정의 + 가드).
--   3) orders BEFORE INSERT 트리거: 로그인 사용자 INSERT는 verified=false, status='pending', paid_at=null로 고정.
--   4) 서버 전용(service_role) 환불/컨텍스트 함수: _account_id_for_auth, _refund_block_reason, _refund_membership_core,
--      refund_membership_server, pg_refund_context, pg_order_context. refund_membership(브라우저용)은 core 래퍼(PG 주문 거부).
--
-- 변경하지 않는 것: 회계 정의(payments), 쿠폰/포인트 복원 로직, 환불 조건(24시간/미사용), PG 승인/취소 API(서버 라우트), billing.
-- 이 세션에서는 production에 실행하지 않았습니다.
-- ============================================================
BEGIN;

-- 1) search_path 고정(본문 불변)
alter function cancel_real_payment(uuid) set search_path = public;
alter function _issue_membership_and_record_payment(orders, text, text) set search_path = public;

-- 2) Mock 결제 확정은 내부 QA 센터에서만
CREATE OR REPLACE FUNCTION public.confirm_test_payment(p_order_id uuid, p_provider_ref text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare
    v_order  orders;
    v_result json;
begin
    select * into v_order from orders where id = p_order_id for update;
    if not found then
        raise exception '주문을 찾을 수 없어요';
    end if;

    if v_order.profile_id not in (select my_profile_ids()) then
        raise exception '본인 주문만 확정할 수 있어요';
    end if;

    if v_order.payment_provider is distinct from 'mock' then
        raise exception '테스트 결제 확정은 Mock 결제 주문에만 사용할 수 있어요';
    end if;

    -- [NEW 2026-10-02] Mock 확정은 결제 없이 수강권을 만든다 — 내부 QA 센터에서만 허용(실제 센터의 mock 주문으로 무료 발급 방지).
    if not exists (select 1 from centers where id = v_order.center_id and coalesce(is_internal, false)) then
        raise exception '테스트 결제는 내부 QA 센터에서만 사용할 수 있어요';
    end if;

    if v_order.status = 'done' then
        return json_build_object('already_done', true);
    end if;

    v_result := _issue_membership_and_record_payment(v_order, p_provider_ref, '테스트 결제(Mock Provider) 자동 발급');

    perform ensure_center_member(v_order.center_id, v_order.profile_id);

    return (jsonb_build_object('already_done', false) || v_result::jsonb)::json;
end;
$function$;

revoke all on function confirm_test_payment(uuid, text) from public, anon;
grant execute on function confirm_test_payment(uuid, text) to authenticated, service_role;

-- 3) 회원 INSERT 주문의 서버 소유 필드 고정(service_role/서버 작업은 auth.uid()가 없어 영향 없음)
create or replace function orders_force_server_fields_on_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    if auth.uid() is not null then
        new.verified := false;
        new.status := 'pending';
        new.paid_at := null;
    end if;
    return new;
end;
$$;
revoke all on function orders_force_server_fields_on_insert() from public, anon, authenticated;

drop trigger if exists orders_force_server_fields_on_insert on orders;
create trigger orders_force_server_fields_on_insert
    before insert on orders
    for each row execute function orders_force_server_fields_on_insert();

-- 4) 환불 공통 로직 + 서버 전용 진입점
create or replace function _account_id_for_auth(p_auth_uid uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
    select coalesce(
        (select coalesce(merged_into, id) from accounts where auth_id = p_auth_uid),
        (select account_id from account_auth_identities where auth_id = p_auth_uid)
    );
$$;
revoke all on function _account_id_for_auth(uuid) from public, anon, authenticated;

-- 셀프 환불 가능 여부(24시간/미사용). null이면 환불 가능. 메시지는 기존 refund_membership과 동일.
create or replace function _refund_block_reason(p_mem memberships)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    v_unlimited boolean := false;
    v_hours     numeric;
begin
    select coalesce(p.unlimited, false) into v_unlimited from products p where p.id = p_mem.product_id;
    v_unlimited := coalesce(v_unlimited, false);

    v_hours := extract(epoch from (now() - p_mem.created_at)) / 3600;
    if v_hours > 24 then
        return '결제 후 24시간이 지나 셀프 환불이 어려워요. 센터에 문의해주세요.';
    end if;
    if not v_unlimited and p_mem.total_count is not null
       and p_mem.remaining_count is distinct from p_mem.total_count then
        return '이미 사용한 수강권은 셀프 환불이 어려워요. 센터에 문의해주세요.';
    end if;
    return null;
end;
$$;
revoke all on function _refund_block_reason(memberships) from public, anon, authenticated;

-- 환불 core — 라이브 refund_membership 본문과 동일(소유 계정/PG 허용/강제 여부만 파라미터화)
--   p_allow_pg=false: 실제 PG(toss/portone) 주문이면 거부(브라우저 직접 호출 차단)
--   p_force=true: 24시간/미사용 조건을 건너뜀(서버가 토스 취소 성공을 확인한 뒤 DB 환불을 마무리할 때만)
create or replace function _refund_membership_core(p_membership_id uuid, p_account_id uuid, p_allow_pg boolean, p_force boolean)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
    v_mem          memberships;
    v_reason       text;
    v_amount       int := 0;
    v_still_active int := 0;
    v_order_id     uuid;
begin
    select * into v_mem from memberships
    where id = p_membership_id
      and profile_id in (select id from profiles where account_id = p_account_id)
    for update;

    if not found then
        raise exception '수강권을 찾을 수 없어요';
    end if;
    if v_mem.status = 'refunded' then
        raise exception '이미 환불된 수강권이에요';
    end if;

    v_reason := _refund_block_reason(v_mem);
    if v_reason is not null and not coalesce(p_force, false) then
        raise exception '%', v_reason;
    end if;

    select coalesce(total_amount, 0), order_id into v_amount, v_order_id
    from payments where membership_id = v_mem.id
    order by paid_at desc limit 1;
    v_amount := coalesce(v_amount, 0);

    if not coalesce(p_allow_pg, false) and v_order_id is not null and exists (
        select 1 from orders o where o.id = v_order_id and o.payment_provider in ('toss', 'portone')
    ) then
        raise exception '카드/간편결제로 결제한 수강권은 앱의 환불 요청 기능으로 환불해주세요';
    end if;

    update memberships
       set status = 'refunded', remaining_count = 0
     where id = v_mem.id;

    if v_amount > 0 then
        insert into payments (
            center_id, profile_id, membership_id,
            sale_type, revenue_category,
            card_amount, cash_amount, transfer_amount, point_amount,
            total_amount, unpaid_amount, paid_at, status, memo
        ) values (
            v_mem.center_id, v_mem.profile_id, v_mem.id,
            'refund', 'membership',
            0, 0, 0, 0,
            -v_amount, 0, now(), 'paid',
            '앱 셀프 환불'
        );
    end if;

    -- 이 결제에 쓰인 쿠폰이 있으면 available로 복원
    if v_order_id is not null then
        update member_coupons
           set status = 'available', used_at = null, order_id = null
         where order_id = v_order_id and status = 'used';

        -- 이 주문에 실제로 차감된 포인트를 전액 복원(원장 unique 인덱스로 1회)
        perform _restore_order_points(v_order_id, '환불 포인트 복원');
    end if;

    select count(*) into v_still_active
    from memberships m
    where m.profile_id = v_mem.profile_id
      and m.center_id = v_mem.center_id
      and m.status = 'active'
      and (m.remaining_count is null or m.remaining_count > 0)
      and (m.expires_at is null or m.expires_at >= current_date);

    if v_still_active = 0 then
        update center_members
           set status = 'expired'
         where profile_id = v_mem.profile_id
           and center_id = v_mem.center_id
           and status <> 'dormant';
    end if;

    return json_build_object('refunded', true, 'amount', v_amount);
end;
$$;
revoke all on function _refund_membership_core(uuid, uuid, boolean, boolean) from public, anon, authenticated;

-- 브라우저(앱) 호출용: 기존 시그니처/권한 유지, PG 결제 주문은 거부
create or replace function refund_membership(p_membership_id uuid)
returns json
language plpgsql
security definer
set search_path = public
as $$
begin
    return _refund_membership_core(p_membership_id, my_account_id(), false, false);
end;
$$;
revoke all on function refund_membership(uuid) from public, anon;
grant execute on function refund_membership(uuid) to authenticated;

-- 서버 라우트 전용(service_role): 서버가 검증한 로그인 사용자(auth uid)의 수강권만 환불
create or replace function refund_membership_server(p_membership_id uuid, p_auth_uid uuid, p_allow_pg boolean, p_force boolean)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
    v_account uuid := _account_id_for_auth(p_auth_uid);
begin
    if v_account is null then
        raise exception '로그인 정보를 확인할 수 없어요';
    end if;
    return _refund_membership_core(p_membership_id, v_account, p_allow_pg, p_force);
end;
$$;
revoke all on function refund_membership_server(uuid, uuid, boolean, boolean) from public, anon, authenticated;
grant execute on function refund_membership_server(uuid, uuid, boolean, boolean) to service_role;

-- 환불 사전 조회(서버 전용): 본인 수강권의 상태/환불 가능 여부/PG 취소에 필요한 값. 본인 것이 아니면 null.
create or replace function pg_refund_context(p_membership_id uuid, p_auth_uid uuid)
returns json
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    v_account uuid := _account_id_for_auth(p_auth_uid);
    v_mem     memberships;
    v_pay     record;
    v_provider text;
begin
    if v_account is null then
        return null;
    end if;
    select * into v_mem from memberships
     where id = p_membership_id and profile_id in (select id from profiles where account_id = v_account);
    if not found then
        return null;
    end if;

    select order_id, total_amount, pg_transaction_id into v_pay
      from payments where membership_id = v_mem.id order by paid_at desc limit 1;
    if v_pay.order_id is not null then
        select payment_provider into v_provider from orders where id = v_pay.order_id;
    end if;

    return json_build_object(
        'membershipId', v_mem.id,
        'status', v_mem.status,
        'blockReason', case when v_mem.status = 'refunded' then null else _refund_block_reason(v_mem) end,
        'orderId', v_pay.order_id,
        'provider', v_provider,
        'paymentKey', v_pay.pg_transaction_id,
        'amount', coalesce(v_pay.total_amount, 0)
    );
end;
$$;
revoke all on function pg_refund_context(uuid, uuid) from public, anon, authenticated;
grant execute on function pg_refund_context(uuid, uuid) to service_role;

-- 주문 사전 조회(서버 전용): 로그인 사용자 본인 주문일 때만 반환(아니면 null — 존재 여부를 알려주지 않는다).
create or replace function pg_order_context(p_order_id uuid, p_auth_uid uuid)
returns json
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    v_account uuid := _account_id_for_auth(p_auth_uid);
    v_order   orders;
begin
    if v_account is null then
        return null;
    end if;
    select * into v_order from orders
     where id = p_order_id and profile_id in (select id from profiles where account_id = v_account);
    if not found then
        return null;
    end if;
    return json_build_object(
        'orderId', v_order.id,
        'status', v_order.status,
        'amount', v_order.amount,
        'provider', v_order.payment_provider
    );
end;
$$;
revoke all on function pg_order_context(uuid, uuid) from public, anon, authenticated;
grant execute on function pg_order_context(uuid, uuid) to service_role;

COMMIT;

-- ============================================================
-- 적용 전 확인(읽기 전용)
-- ============================================================
-- select proname, proconfig, has_function_privilege('anon', oid, 'execute') as anon_exec
--   from pg_proc where pronamespace = 'public'::regnamespace
--    and proname in ('cancel_real_payment', '_issue_membership_and_record_payment', 'confirm_test_payment', 'refund_membership');

-- ============================================================
-- 적용 후 확인(읽기 전용)
-- ============================================================
select
    (select 'search_path=public' = any (proconfig) from pg_proc where oid = 'cancel_real_payment(uuid)'::regprocedure) as cancel_real_search_path_must_be_true,
    (select 'search_path=public' = any (proconfig) from pg_proc where oid = '_issue_membership_and_record_payment(orders,text,text)'::regprocedure) as issue_search_path_must_be_true,
    has_function_privilege('anon', 'confirm_test_payment(uuid,text)', 'execute') as test_confirm_anon_must_be_false,
    (select pg_get_functiondef('confirm_test_payment(uuid,text)'::regprocedure) like '%is_internal%') as test_confirm_internal_only_must_be_true,
    (select count(*) from pg_trigger where tgname = 'orders_force_server_fields_on_insert' and not tgisinternal) as insert_guard_trigger_must_be_1,
    has_function_privilege('authenticated', 'refund_membership(uuid)', 'execute') as refund_auth_must_be_true,
    has_function_privilege('anon', 'refund_membership(uuid)', 'execute') as refund_anon_must_be_false,
    has_function_privilege('authenticated', 'refund_membership_server(uuid,uuid,boolean,boolean)', 'execute') as refund_server_auth_must_be_false,
    has_function_privilege('service_role', 'refund_membership_server(uuid,uuid,boolean,boolean)', 'execute') as refund_server_service_must_be_true,
    has_function_privilege('authenticated', 'pg_refund_context(uuid,uuid)', 'execute') as refund_ctx_auth_must_be_false,
    has_function_privilege('authenticated', 'pg_order_context(uuid,uuid)', 'execute') as order_ctx_auth_must_be_false,
    has_function_privilege('authenticated', '_refund_membership_core(uuid,uuid,boolean,boolean)', 'execute') as core_auth_must_be_false,
    (select pg_get_functiondef('refund_membership(uuid)'::regprocedure) like '%_refund_membership_core%') as refund_uses_core_must_be_true;
