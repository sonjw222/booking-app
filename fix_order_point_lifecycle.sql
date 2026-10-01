-- ============================================================
-- 주문 포인트 생명주기 (2026-10-02) — 주문 취소/전체 환불 시 사용한 포인트를 정확히 1회 복원
--
-- [감사 결과(Production 라이브 정의 기준)]
--   · use_points(): 주문 id를 받지만 주문 소유/상태/중복을 검사하지 않아 같은 주문에 두 번 차감될 수 있었다.
--   · 회원 취소(orders "주문 본인 취소" UPDATE 정책), 관리자 취소(updateOrderStatus), cancel_real_payment 모두
--     orders.status만 바꾸고 포인트 원장은 건드리지 않았다 → 차감된 포인트가 영구 손실.
--   · refund_membership(): 쿠폰은 available로 되돌리지만 포인트 복원 로직이 없었다.
--   · fulfill_order / confirm_real_payment: status='done'만 확인해 cancelled 주문을 다시 발급할 수 있었다.
--   · 관리자 UPDATE 정책(pass.payment.create)은 어떤 상태 전이도 허용(done→cancelled, cancelled→pending 등).
--
-- [이 migration]
--   1) point_transactions.reverses_id(nullable) + unique 인덱스: 복원 행은 반드시 원본 차감 행 1개를 가리키고, 한 차감 행은 한 번만 복원된다.
--      (같은 주문의 '결제 시 사용' 차감도 주문당 1행으로 unique) — 기존 원장 행은 UPDATE/DELETE하지 않고 새 양수 행만 추가한다.
--   2) _restore_order_points(): 내부 헬퍼(PUBLIC/anon/authenticated 실행 차단). 주문 행 잠금 → 실제 차감 원장을 읽어 같은 금액을 +로 기록.
--      orders.points_used 값은 믿지 않는다.
--   3) orders 상태 전이 가드(BEFORE) + 취소 시 포인트 복원(AFTER) 트리거: 회원/관리자/PG 취소가 어느 경로든 같은 트랜잭션에서 복원된다.
--      cancelled는 종료 상태, done은 변경 불가(환불은 refund_membership 경로).
--   4) use_points(): 주문 소유/센터/pending 상태/금액 일치/중복 차감 방어. 주문 없는 용도(order_id null)는 기존 동작 유지.
--   5) refund_membership(): 기존 로직 그대로 + 포인트 복원 1줄(라이브 정의 기준, search_path 고정 추가).
--   6) fulfill_order / confirm_real_payment: cancelled 주문 발급/확정 차단(라이브 정의 기준, 나머지 동일).
--
-- 변경하지 않는 것: payments 금액 정의, 쿠폰 정책, 환불 가능 조건(24시간/미사용), PG 승인/환불 API.
-- 사전 확인(적용 전 0이어야 함): 파일 하단 "적용 전 확인" 쿼리. 이 세션에서는 production에 실행하지 않았습니다.
-- ============================================================
BEGIN;

-- 1) 원장 확장(nullable 추가 + unique 인덱스) — 기존 행/조회 영향 없음
alter table point_transactions add column if not exists reverses_id uuid references point_transactions(id);

create unique index if not exists uq_point_tx_reverses_id
    on point_transactions (reverses_id) where reverses_id is not null;
create unique index if not exists uq_point_tx_order_debit
    on point_transactions (order_id) where order_id is not null and reason = '결제 시 사용' and amount < 0;

-- 2) 내부 헬퍼: 주문에 실제로 차감된 포인트를 한 번만 복원하고, 복원한 금액을 돌려준다
create or replace function _restore_order_points(p_order_id uuid, p_reason text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
    v_row      record;
    v_inserted integer;
    v_restored integer := 0;
begin
    perform 1 from orders where id = p_order_id for update;   -- 주문 단위로 직렬화
    if not found then
        return 0;
    end if;

    for v_row in
        select id, profile_id, center_id, amount
          from point_transactions
         where order_id = p_order_id
           and reason = '결제 시 사용'
           and amount < 0
         order by created_at, id
    loop
        insert into point_transactions (profile_id, center_id, amount, reason, order_id, reverses_id)
        values (v_row.profile_id, v_row.center_id, -v_row.amount, p_reason, p_order_id, v_row.id)
        on conflict (reverses_id) where reverses_id is not null do nothing;
        get diagnostics v_inserted = row_count;
        if v_inserted > 0 then
            v_restored := v_restored + (-v_row.amount);
        end if;
    end loop;

    return v_restored;
end;
$$;
revoke all on function _restore_order_points(uuid, text) from public, anon, authenticated;

-- 3) 주문 상태 전이 가드 + 취소 시 포인트 복원
create or replace function orders_guard_status_transition()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    if new.status is not distinct from old.status then
        return new;
    end if;
    if old.status = 'cancelled' then
        raise exception '이미 취소된 주문은 다시 처리할 수 없어요';
    end if;
    if old.status = 'done' then
        raise exception '이미 발급된 주문은 상태를 바꿀 수 없어요. 환불은 환불 기능을 이용해주세요';
    end if;
    return new;
end;
$$;
revoke all on function orders_guard_status_transition() from public, anon, authenticated;

drop trigger if exists orders_guard_status_transition on orders;
create trigger orders_guard_status_transition
    before update of status on orders
    for each row execute function orders_guard_status_transition();

create or replace function orders_restore_points_on_cancel()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    if new.status = 'cancelled' and old.status is distinct from 'cancelled' then
        perform _restore_order_points(new.id, '주문 취소 포인트 복원');
    end if;
    return new;
end;
$$;
revoke all on function orders_restore_points_on_cancel() from public, anon, authenticated;

drop trigger if exists orders_restore_points_on_cancel on orders;
create trigger orders_restore_points_on_cancel
    after update of status on orders
    for each row execute function orders_restore_points_on_cancel();

-- 4) use_points: 주문에 묶인 포인트 차감은 소유/상태/금액을 확인하고 주문당 1회만
create or replace function use_points(p_center_id uuid, p_profile_id uuid, p_amount integer, p_order_id uuid default null)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
    v_balance  int;
    v_order    orders;
    v_existing int;
begin
    if p_profile_id not in (select my_profile_ids()) then
        raise exception '본인 포인트만 사용할 수 있어요';
    end if;
    if p_amount <= 0 then
        return json_build_object('used', 0);
    end if;

    perform 1 from profiles where id = p_profile_id for update;

    if p_order_id is not null then
        select * into v_order from orders where id = p_order_id for update;
        if not found then
            raise exception '주문을 찾을 수 없어요';
        end if;
        if v_order.profile_id is distinct from p_profile_id or v_order.center_id is distinct from p_center_id then
            raise exception '본인 주문에만 포인트를 사용할 수 있어요';
        end if;
        if v_order.status <> 'pending' then
            raise exception '결제 대기 중인 주문에만 포인트를 사용할 수 있어요';
        end if;
        if coalesce(v_order.points_used, 0) <> p_amount then
            raise exception '주문의 포인트 사용 금액과 일치하지 않아요';
        end if;
        select coalesce(sum(-amount), 0) into v_existing
          from point_transactions
         where order_id = p_order_id and reason = '결제 시 사용' and amount < 0;
        if v_existing > 0 then
            -- 이미 차감된 주문 — 같은 요청이 다시 와도 두 번 차감하지 않는다
            return json_build_object('used', v_existing, 'already_used', true);
        end if;
    end if;

    select coalesce(sum(amount), 0) into v_balance
    from point_transactions
    where center_id = p_center_id and profile_id = p_profile_id;

    if v_balance < p_amount then
        raise exception '포인트가 부족해요';
    end if;

    insert into point_transactions (profile_id, center_id, amount, reason, order_id)
    values (p_profile_id, p_center_id, -p_amount, '결제 시 사용', p_order_id);

    return json_build_object('used', p_amount);
end;
$$;
revoke all on function use_points(uuid, uuid, integer, uuid) from public, anon;
grant execute on function use_points(uuid, uuid, integer, uuid) to authenticated, service_role;

-- 5) refund_membership — 라이브 정의 + 포인트 복원(+ search_path 고정)
CREATE OR REPLACE FUNCTION public.refund_membership(p_membership_id uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare
    v_mem     record;
    v_unlimited boolean := false;
    v_hours   numeric;
    v_amount  int := 0;
    v_still_active int := 0;
    v_order_id uuid;
begin
    select * into v_mem from memberships
    where id = p_membership_id
      and profile_id in (select id from profiles where account_id = my_account_id())
    for update;

    if not found then
        raise exception '수강권을 찾을 수 없어요';
    end if;
    if v_mem.status = 'refunded' then
        raise exception '이미 환불된 수강권이에요';
    end if;

    select coalesce(p.unlimited, false) into v_unlimited
    from products p where p.id = v_mem.product_id;
    v_unlimited := coalesce(v_unlimited, false);

    v_hours := extract(epoch from (now() - v_mem.created_at)) / 3600;
    if v_hours > 24 then
        raise exception '결제 후 24시간이 지나 셀프 환불이 어려워요. 센터에 문의해주세요.';
    end if;

    if not v_unlimited and v_mem.total_count is not null
       and v_mem.remaining_count is distinct from v_mem.total_count then
        raise exception '이미 사용한 수강권은 셀프 환불이 어려워요. 센터에 문의해주세요.';
    end if;

    select coalesce(total_amount, 0), order_id into v_amount, v_order_id
    from payments where membership_id = v_mem.id
    order by paid_at desc limit 1;
    v_amount := coalesce(v_amount, 0);

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

    -- [FIX] 이 결제에 쓰인 쿠폰이 있으면 available로 복원(요청 18번)
    if v_order_id is not null then
        update member_coupons
           set status = 'available', used_at = null, order_id = null
         where order_id = v_order_id and status = 'used';

        -- [NEW 2026-10-02] 이 주문에 실제로 차감된 포인트(point_transactions의 '결제 시 사용' 원장)를 전액 복원한다.
        -- 쿠폰 할인은 포인트가 아니므로 복원 대상이 아니다. 같은 주문은 원장 unique 인덱스 때문에 두 번 복원되지 않는다.
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
$function$;

-- 6) fulfill_order — 라이브 정의 + cancelled 차단
CREATE OR REPLACE FUNCTION public.fulfill_order(p_order_id uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_order      orders;
    v_product    record;
    v_membership_id uuid;
    v_count      int;
    v_expires    date;
    v_starts     date;
    v_rm         record;
    v_expected   int;
    v_auto       jsonb;
begin
    select * into v_order from orders where id = p_order_id for update;
    if not found then
        raise exception '주문을 찾을 수 없어요';
    end if;

    if not (has_permission(v_order.center_id, 'pass.payment.create') or is_platform_admin()) then
        raise exception '이 주문을 처리할 권한이 없어요';
    end if;

    if v_order.status = 'done' then
        return json_build_object('already_done', true);
    end if;

    -- [NEW 2026-10-02] 취소된 주문은 다시 발급할 수 없다(취소 시 포인트가 이미 복원됐으므로 재발급되면 이중 혜택).
    if v_order.status = 'cancelled' then
        raise exception '취소된 주문은 발급할 수 없어요';
    end if;

    -- 금액 검증: 주문 금액(할인/포인트 반영 후)을 상품 원가가 아니라 서버가 다시 계산한 기대금액과 비교한다.
    if not coalesce(v_order.verified, false) or v_order.member_coupon_id is not null then
        if v_order.product_id is null then
            raise exception '주문 금액을 확인할 수 없어요. 상품 정보가 없어요 — 센터에서 직접 확인해주세요.';
        end if;
        v_expected := _order_expected_amount(v_order, true);
        if not coalesce(v_order.verified, false) and v_order.amount is distinct from v_expected then
            raise exception '주문 금액이 서버 계산 금액과 달라요 (주문 %원, 확인된 금액 %원) — 쿠폰/포인트를 확인해주세요.',
                v_order.amount, v_expected;
        end if;
    end if;

    v_count := null; v_expires := null; v_starts := current_date;
    if v_order.product_id is not null then
        select * into v_product from products where id = v_order.product_id;
        if found then
            -- 횟수 선택형 상품은 주문에 snapshot된 selected_count만큼, 고정 상품은 상품 정의 횟수(클라이언트 값 무시).
            if coalesce(v_product.purchase_count_selectable, false) then
                if v_order.selected_count is null or v_order.selected_count < 1 then
                    raise exception '구매 횟수 정보가 없는 주문이에요(관리자 문의)';
                end if;
                v_count := v_order.selected_count;
            else
                v_count := case when v_product.unlimited_pass then null else v_product.total_count end;
            end if;
            if v_product.expiry_mode = 'rolling_month' then
                select * into v_rm from calc_rolling_month_dates(now(), v_product.rolling_month_cutoff_day);
                v_expires := v_rm.expires_at;
                if not coalesce(v_product.rolling_month_allow_early_use, false) then
                    v_starts := v_rm.starts_at;
                end if;
            else
                v_expires := case v_product.expiry_mode
                    when 'date' then v_product.expiry_date
                    when 'days' then (now() + (coalesce(v_product.expiry_days, 0) || ' days')::interval)::date
                    else null
                end;
            end if;
        end if;
    end if;

    insert into memberships (
        profile_id, center_id, product_id, product_name,
        pass_type, total_count, remaining_count, expires_at, starts_at, status,
        bound_day_of_week, bound_start_time, selected_size, auto_book_requested
    ) values (
        v_order.profile_id, v_order.center_id, v_order.product_id, v_order.product_name,
        'count', v_count, v_count, v_expires, v_starts, 'active',
        v_order.selected_day_of_week, v_order.selected_start_time, v_order.selected_size,
        coalesce(v_order.auto_book, false)
    ) returning id into v_membership_id;

    insert into payments (
        center_id, profile_id, membership_id, order_id,
        sale_type, revenue_category,
        card_amount, cash_amount, transfer_amount, point_amount, direct_amount,
        total_amount, unpaid_amount, paid_at, status, memo
    ) values (
        v_order.center_id, v_order.profile_id, v_membership_id, v_order.id,
        'new', 'membership',
        case when v_order.pay_method in ('card','kakao','toss') then v_order.amount else 0 end,
        0,
        case when v_order.pay_method = 'transfer' then v_order.amount else 0 end,
        0,
        case when v_order.pay_method = 'direct' then v_order.amount else 0 end,
        v_order.amount, 0, now(), 'paid',
        '앱 주문 자동 발급'
    );

    -- 센터 쿠폰은 발급 성공 시점에만 used 처리(PG 경로와 동일)
    if v_order.member_coupon_id is not null then
        update member_coupons
           set status = 'used', used_at = now(), order_id = v_order.id
         where id = v_order.member_coupon_id;
    end if;

    perform ensure_center_member(v_order.center_id, v_order.profile_id);

    -- 자동예약: 결제수단과 무관한 공통 헬퍼. 실패해도 발급은 유지하되 이유를 반환한다.
    v_auto := _order_auto_book(v_membership_id, coalesce(v_order.auto_book, false));

    update orders set status = 'done', paid_at = now() where id = p_order_id;

    return (jsonb_build_object(
        'already_done', false,
        'membership_id', v_membership_id,
        'amount', v_order.amount
    ) || v_auto)::json;
end;
$function$;

-- 7) confirm_real_payment — 라이브 정의 + cancelled 차단
CREATE OR REPLACE FUNCTION public.confirm_real_payment(p_order_id uuid, p_payment_key text, p_amount integer)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
    v_order  orders;
    v_result json;
begin
    select * into v_order from orders where id = p_order_id for update;
    if not found then
        raise exception '주문을 찾을 수 없어요';
    end if;

    if v_order.payment_provider is distinct from 'toss' and v_order.payment_provider is distinct from 'portone' then
        raise exception '실 결제 확정은 실제 PG 주문에만 사용할 수 있어요';
    end if;

    if v_order.amount is distinct from p_amount then
        raise exception '결제 금액이 주문 금액과 일치하지 않아요';
    end if;

    if v_order.status = 'done' then
        return json_build_object('already_done', true);
    end if;

    -- [NEW 2026-10-02] 취소된 주문은 다시 확정할 수 없다(취소 시 포인트가 이미 복원됨).
    if v_order.status = 'cancelled' then
        raise exception '취소된 주문은 결제를 확정할 수 없어요';
    end if;

    v_result := _issue_membership_and_record_payment(v_order, p_payment_key, '실 결제(' || v_order.payment_provider || ') 자동 발급');

    return (jsonb_build_object('already_done', false) || v_result::jsonb)::json;
end;
$function$;

COMMIT;

-- ============================================================
-- 적용 전 확인(읽기 전용, 0이어야 unique 인덱스가 만들어진다)
-- ============================================================
-- select count(*) from (select order_id from point_transactions where order_id is not null and reason = '결제 시 사용' and amount < 0 group by order_id having count(*) > 1) d;

-- ============================================================
-- 적용 후 확인(읽기 전용)
-- ============================================================
select
    (select count(*) from pg_indexes where indexname in ('uq_point_tx_reverses_id', 'uq_point_tx_order_debit')) as indexes_must_be_2,
    (select count(*) from pg_trigger where tgname in ('orders_guard_status_transition', 'orders_restore_points_on_cancel') and not tgisinternal) as triggers_must_be_2,
    has_function_privilege('anon', '_restore_order_points(uuid,text)', 'execute') as helper_anon_must_be_false,
    has_function_privilege('authenticated', '_restore_order_points(uuid,text)', 'execute') as helper_auth_must_be_false,
    has_function_privilege('anon', 'use_points(uuid,uuid,integer,uuid)', 'execute') as use_points_anon_must_be_false,
    has_function_privilege('authenticated', 'use_points(uuid,uuid,integer,uuid)', 'execute') as use_points_auth_must_be_true,
    (select pg_get_functiondef('refund_membership(uuid)'::regprocedure) like '%_restore_order_points%') as refund_restores_must_be_true,
    (select pg_get_functiondef('fulfill_order(uuid)'::regprocedure) like '%취소된 주문은 발급할 수 없어요%') as fulfill_blocks_cancelled_must_be_true,
    (select pg_get_functiondef('confirm_real_payment(uuid,text,integer)'::regprocedure) like '%취소된 주문은 결제를 확정할 수 없어요%') as confirm_blocks_cancelled_must_be_true;
