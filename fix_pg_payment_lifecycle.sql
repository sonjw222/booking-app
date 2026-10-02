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
--   5) PG 환불 TOCTOU 차단: memberships.pg_refund_started_at(서버 전용 "환불 진행" 표시) + pg_refund_begin/pg_refund_release.
--      begin은 행 잠금 아래에서 환불 가능 조건(24시간/미사용)을 확인하고 표시를 건다. 표시가 있는 동안
--        · memberships.remaining_count 감소(모든 예약/차감 경로가 이 UPDATE를 거친다: reserve_class/reserve_with_membership/reserve_with_goods/
--          manager_book_member/admin_assign_reservation/_auto_book_membership_core/manager_set_attendance 등)와
--        · 그 수강권을 쓰는 새 reservations INSERT 를 DB 트리거가 거부한다(예약 RPC 본문은 수정하지 않는다 — 라이브 정의 보존).
--      표시는 서버(SECURITY DEFINER 함수의 GUC)만 바꿀 수 있다.
--      reservations 트리거는 BEFORE INSERT OR UPDATE OF status, membership_id 로 pg_refund_begin과 같은 수강권 행 잠금(FOR UPDATE)을 잡고 표시를 확인한다
--      (예약 생성 / 대기→확정 승격 / 취소 복구 / 잠긴 수강권으로의 변경 차단, cancelled로 가는 경로는 허용).
--      "미사용" 판정(_refund_block_reason)은 횟수 소비 + 현재 활성 예약(confirmed/waitlisted/attended/no_show)을 함께 본다(무제한권/대기 포함, cancelled 예약은 제외).
--      ※ 이 판정은 direct/manual 셀프 환불에도 같이 적용된다(무제한권·대기 예약이 있던 수강권이 예전에는 환불 가능으로 잘못 판정됐다). 환불 core의 force는 24시간 조건만 건너뛰고 "이미 사용" 조건은 항상 확인한다.
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

-- 3b) PG 환불 진행 표시 + 사용 차단 트리거
alter table memberships add column if not exists pg_refund_started_at timestamptz;

create or replace function memberships_guard_pg_refund()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    v_writer boolean := coalesce(current_setting('app.pg_refund_write', true), '') = 'on';
begin
    -- 표시 자체는 서버 함수만 바꿀 수 있다(회원/매니저가 REST로 만들거나 풀 수 없다). service_role/서버 작업(JWT 없음)은 통과.
    if new.pg_refund_started_at is distinct from old.pg_refund_started_at and not v_writer and auth.uid() is not null then
        raise exception '환불 진행 상태는 서버에서만 변경할 수 있어요' using errcode = '42501';
    end if;
    -- 환불 진행 중인 수강권의 횟수 차감(예약/출석 등 모든 사용 경로)은 거부. 복구(증가)는 허용.
    if old.pg_refund_started_at is not null and not v_writer
       and new.remaining_count is not null and old.remaining_count is not null and new.remaining_count < old.remaining_count then
        raise exception '환불 처리 중인 수강권이라 지금은 사용할 수 없어요. 잠시 후 다시 시도해주세요';
    end if;
    return new;
end;
$$;
revoke all on function memberships_guard_pg_refund() from public, anon, authenticated;

drop trigger if exists memberships_guard_pg_refund on memberships;
create trigger memberships_guard_pg_refund
    before update of remaining_count, pg_refund_started_at on memberships
    for each row execute function memberships_guard_pg_refund();

-- 환불 진행 중인 수강권을 쓰는 예약 생성/활성화를 막는다. pg_refund_begin과 "같은 행 잠금(FOR UPDATE)"으로 직렬화한다:
--   예약이 먼저 수강권 행을 잡았으면 begin은 그 예약 트랜잭션이 끝난 뒤 최신 상태를 보고 판단(blocked),
--   begin이 먼저 잡았으면 이 트리거가 begin 종료까지 기다린 뒤 표시를 보고 거부한다(횟수 차감이 없는 무제한권도 동일).
-- 잠금 순서: 기존 예약 RPC가 이미 "수업(classes) → 수강권(memberships)" 순서로 잠그고, 이 트리거도 수강권 행만 추가로 잠근다(같은 행을 같은 트랜잭션이 다시 잠그는 것은 안전).
--   begin/refund core는 수강권 행만 잠그고 예약/수업 행은 잠그지 않아(예약은 일반 SELECT) 역방향 대기가 생기지 않는다.
-- 대상: INSERT, 그리고 status/membership_id UPDATE 중 "활성 상태(confirmed/waitlisted/attended/no_show)로 들어가거나 수강권이 바뀌는" 경우.
--   cancelled로 가는 취소/복구 경로와 변화 없는 UPDATE는 막지 않는다. (대기 → 확정 승격, 취소된 예약의 복구, 잠긴 수강권으로의 변경을 차단)
create or replace function reservations_guard_pg_refund_lock()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    v_started timestamptz;
begin
    if new.membership_id is null or new.status not in ('confirmed', 'waitlisted', 'attended', 'no_show') then
        return new;
    end if;
    if tg_op = 'UPDATE' and new.status is not distinct from old.status and new.membership_id is not distinct from old.membership_id then
        return new;
    end if;
    select pg_refund_started_at into v_started from memberships where id = new.membership_id for update;
    if v_started is not null then
        raise exception '환불 처리 중인 수강권이라 지금은 예약에 사용할 수 없어요. 잠시 후 다시 시도해주세요';
    end if;
    return new;
end;
$$;
revoke all on function reservations_guard_pg_refund_lock() from public, anon, authenticated;

drop trigger if exists reservations_guard_pg_refund_lock on reservations;
create trigger reservations_guard_pg_refund_lock
    before insert or update of status, membership_id on reservations
    for each row execute function reservations_guard_pg_refund_lock();

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

-- 셀프 환불 가능 여부(24시간/미사용). null이면 환불 가능. 메시지는 기존 refund_membership과 동일. p_skip_time은 24시간 조건만 건너뜀.
create or replace function _refund_block_reason(p_mem memberships, p_skip_time boolean default false)
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
    if v_hours > 24 and not coalesce(p_skip_time, false) then
        return '결제 후 24시간이 지나 셀프 환불이 어려워요. 센터에 문의해주세요.';
    end if;
    -- 사용 여부는 p_skip_time과 무관하게 항상 확인한다
    -- (1) 횟수 소비: 횟수권의 남은 횟수가 총 횟수와 다르면 사용한 것
    if not v_unlimited and p_mem.total_count is not null
       and p_mem.remaining_count is distinct from p_mem.total_count then
        return '이미 사용한 수강권은 셀프 환불이 어려워요. 센터에 문의해주세요.';
    end if;
    -- (2) 현재 활성 예약/사용 기록: 확정/대기/출석/결석 예약이 이 수강권에 연결돼 있으면 미사용이 아니다.
    --     대기(waitlisted)는 확정 전이라 횟수를 차감하지 않고, 무제한권은 횟수 차감 자체가 없으므로 예약 상태로 판정한다.
    --     취소(cancelled)된 예약은 횟수가 복구된 기존 동작과 같이 미사용으로 본다(예약 이력이 한 번 있었다고 영구 차단하지 않는다).
    if exists (
        select 1 from reservations r
         where r.membership_id = p_mem.id and r.status in ('confirmed', 'waitlisted', 'attended', 'no_show')
    ) then
        return '예약 중이거나 이용한 수업이 있는 수강권은 셀프 환불이 어려워요. 센터에 문의해주세요.';
    end if;
    return null;
end;
$$;
revoke all on function _refund_block_reason(memberships, boolean) from public, anon, authenticated;

-- 환불 core — 라이브 refund_membership 본문과 동일(소유 계정/PG 허용/강제 여부만 파라미터화)
--   p_allow_pg=false: 실제 PG(toss/portone) 주문이면 거부(브라우저 직접 호출 차단)
--   p_skip_time_check=true: 24시간 조건만 건너뜀(서버가 토스 취소 성공을 확인한 뒤 DB 환불을 마무리할 때만). "이미 사용함" 조건은 항상 확인.
create or replace function _refund_membership_core(p_membership_id uuid, p_account_id uuid, p_allow_pg boolean, p_skip_time_check boolean)
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

    v_reason := _refund_block_reason(v_mem, coalesce(p_skip_time_check, false));
    if v_reason is not null then
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

    -- 환불 완료: 횟수를 0으로 만들고 환불 진행 표시를 해제(트리거에는 서버 쓰기임을 표시)
    perform set_config('app.pg_refund_write', 'on', true);
    update memberships
       set status = 'refunded', remaining_count = 0, pg_refund_started_at = null
     where id = v_mem.id;
    perform set_config('app.pg_refund_write', '', true);

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
create or replace function refund_membership_server(p_membership_id uuid, p_auth_uid uuid, p_allow_pg boolean, p_skip_time_check boolean)
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
    return _refund_membership_core(p_membership_id, v_account, p_allow_pg, p_skip_time_check);
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
        'refundPending', v_mem.pg_refund_started_at is not null,
        'orderId', v_pay.order_id,
        'provider', v_provider,
        'paymentKey', v_pay.pg_transaction_id,
        'amount', coalesce(v_pay.total_amount, 0)
    );
end;
$$;
revoke all on function pg_refund_context(uuid, uuid) from public, anon, authenticated;
grant execute on function pg_refund_context(uuid, uuid) to service_role;

-- PG 환불 시작(서버 전용): 행 잠금 아래에서 환불 가능 조건을 확인하고 "환불 진행" 표시를 건다.
--   locked: 새로 표시함 / resumed: 이전 시도의 표시가 남아 있음(이어서 처리) / blocked: 환불 불가(reason) / refunded: 이미 환불됨
create or replace function pg_refund_begin(p_membership_id uuid, p_auth_uid uuid)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
    v_account uuid := _account_id_for_auth(p_auth_uid);
    v_mem     memberships;
    v_reason  text;
begin
    if v_account is null then
        raise exception '로그인 정보를 확인할 수 없어요';
    end if;
    select * into v_mem from memberships
     where id = p_membership_id and profile_id in (select id from profiles where account_id = v_account)
     for update;
    if not found then
        raise exception '수강권을 찾을 수 없어요';
    end if;
    if v_mem.status = 'refunded' then
        return json_build_object('state', 'refunded');
    end if;
    if v_mem.pg_refund_started_at is not null then
        return json_build_object('state', 'resumed');
    end if;
    v_reason := _refund_block_reason(v_mem);
    if v_reason is not null then
        return json_build_object('state', 'blocked', 'reason', v_reason);
    end if;

    perform set_config('app.pg_refund_write', 'on', true);
    update memberships set pg_refund_started_at = now() where id = v_mem.id;
    perform set_config('app.pg_refund_write', '', true);
    return json_build_object('state', 'locked');
end;
$$;
revoke all on function pg_refund_begin(uuid, uuid) from public, anon, authenticated;
grant execute on function pg_refund_begin(uuid, uuid) to service_role;

-- PG 환불 표시 해제(서버 전용): 토스가 취소하지 않았음이 확실할 때 수강권을 원래 이용 가능 상태로 되돌린다. 이미 환불된 수강권은 건드리지 않는다.
create or replace function pg_refund_release(p_membership_id uuid, p_auth_uid uuid)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
    v_account  uuid := _account_id_for_auth(p_auth_uid);
    v_released integer := 0;
begin
    if v_account is null then
        raise exception '로그인 정보를 확인할 수 없어요';
    end if;
    perform set_config('app.pg_refund_write', 'on', true);
    update memberships set pg_refund_started_at = null
     where id = p_membership_id and status <> 'refunded' and pg_refund_started_at is not null
       and profile_id in (select id from profiles where account_id = v_account);
    get diagnostics v_released = row_count;
    perform set_config('app.pg_refund_write', '', true);
    return json_build_object('released', v_released > 0);
end;
$$;
revoke all on function pg_refund_release(uuid, uuid) from public, anon, authenticated;
grant execute on function pg_refund_release(uuid, uuid) to service_role;

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
    (select pg_get_functiondef('refund_membership(uuid)'::regprocedure) like '%_refund_membership_core%') as refund_uses_core_must_be_true,
    (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'memberships' and column_name = 'pg_refund_started_at') as refund_lock_column_must_be_1,
    (select count(*) from pg_trigger where tgname in ('memberships_guard_pg_refund', 'reservations_guard_pg_refund_lock') and not tgisinternal) as refund_lock_triggers_must_be_2,
    (select pg_get_triggerdef(oid) like '%BEFORE INSERT OR UPDATE OF status, membership_id ON public.reservations%' from pg_trigger where tgname = 'reservations_guard_pg_refund_lock' and not tgisinternal) as reservation_guard_event_must_be_true,
    (select pg_get_functiondef('reservations_guard_pg_refund_lock()'::regprocedure) like '%for update%') as reservation_guard_locks_membership_must_be_true,
    (select pg_get_functiondef('_refund_block_reason(memberships,boolean)'::regprocedure) like '%from reservations r%') as unused_check_includes_reservations_must_be_true,
    has_function_privilege('authenticated', 'reservations_guard_pg_refund_lock()', 'execute') as reservation_guard_auth_must_be_false,
    has_function_privilege('authenticated', '_refund_block_reason(memberships,boolean)', 'execute') as block_reason_auth_must_be_false,
    has_function_privilege('authenticated', 'pg_refund_begin(uuid,uuid)', 'execute') as refund_begin_auth_must_be_false,
    has_function_privilege('authenticated', 'pg_refund_release(uuid,uuid)', 'execute') as refund_release_auth_must_be_false,
    has_function_privilege('service_role', 'pg_refund_begin(uuid,uuid)', 'execute') as refund_begin_service_must_be_true,
    (select count(*) from memberships where pg_refund_started_at is not null) as stuck_refund_locks_should_be_0;
