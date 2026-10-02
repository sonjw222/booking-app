-- ============================================================
-- fix_pg_payment_lifecycle.sql 롤백 — 신규 함수/트리거 제거, confirm_test_payment/refund_membership를 적용 전 라이브 정의로 복원.
-- ⚠ 롤백하면 (1) 회원이 mock 주문 + confirm_test_payment로 결제 없이 수강권을 받을 수 있는 경로와 verified=true 위조가 다시 열리고,
--   (2) 실제 PG 결제 주문을 브라우저가 DB 환불만 하는 경로가 되살아난다. 서버 라우트(/api/payments/refund)는 롤백된 DB 함수가 없어 동작하지 않는다.
--   search_path는 적용 전 상태(미고정)로 되돌린다.
-- ============================================================
BEGIN;

drop trigger if exists orders_force_server_fields_on_insert on orders;
drop function if exists orders_force_server_fields_on_insert();

drop trigger if exists reservations_guard_pg_refund_lock on reservations;
drop function if exists reservations_guard_pg_refund_lock();
drop trigger if exists memberships_guard_pg_refund on memberships;
drop function if exists memberships_guard_pg_refund();
drop function if exists pg_refund_release(uuid, uuid);
drop function if exists pg_refund_begin(uuid, uuid);
drop function if exists pg_order_context(uuid, uuid);
drop function if exists pg_refund_context(uuid, uuid);
drop function if exists refund_membership_server(uuid, uuid, boolean, boolean);

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

grant execute on function refund_membership(uuid) to authenticated;

drop function if exists _refund_membership_core(uuid, uuid, boolean, boolean);
drop function if exists _refund_block_reason(memberships, boolean);
drop function if exists _account_id_for_auth(uuid);

CREATE OR REPLACE FUNCTION public.confirm_test_payment(p_order_id uuid, p_provider_ref text)
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

    if v_order.profile_id not in (select my_profile_ids()) then
        raise exception '본인 주문만 확정할 수 있어요';
    end if;

    if v_order.payment_provider is distinct from 'mock' then
        raise exception '테스트 결제 확정은 Mock 결제 주문에만 사용할 수 있어요';
    end if;

    if v_order.status = 'done' then
        return json_build_object('already_done', true);
    end if;

    v_result := _issue_membership_and_record_payment(v_order, p_provider_ref, '테스트 결제(Mock Provider) 자동 발급');

    perform ensure_center_member(v_order.center_id, v_order.profile_id);

    return (jsonb_build_object('already_done', false) || v_result::jsonb)::json;
end;
$function$;

grant execute on function confirm_test_payment(uuid, text) to anon, authenticated, service_role;

-- 환불 진행 표시 컬럼 제거(롤백 시점에 표시가 남아 있던 수강권은 이용 가능 상태로 돌아간다)
alter table memberships drop column if exists pg_refund_started_at;

alter function _issue_membership_and_record_payment(orders, text, text) reset search_path;
alter function cancel_real_payment(uuid) reset search_path;

COMMIT;
