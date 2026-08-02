-- ============================================================
-- ⚠️ DRAFT / PROPOSED — DO NOT RUN unless fix_sync_test_payment_center_member.sql was applied ⚠️
-- SYNC-001 롤백 — confirm_test_payment()를 ensure_center_member 호출 추가 이전 상태로 되돌린다.
-- ============================================================

BEGIN;

create or replace function confirm_test_payment(p_order_id uuid, p_provider_ref text)
returns json
language plpgsql
security definer
as $$
declare
    v_order         record;
    v_product       record;
    v_membership_id uuid;
    v_count         int;
    v_expires       date;
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

    v_count := null;
    if v_order.product_id is not null then
        select * into v_product from products where id = v_order.product_id;
        if found then
            v_count := v_product.total_count;
        end if;
    end if;

    v_expires := (now() + interval '60 days')::date;

    update orders set status = 'paid', paid_at = now() where id = p_order_id;

    insert into memberships (
        profile_id, center_id, product_id, product_name,
        pass_type, total_count, remaining_count, expires_at, status
    ) values (
        v_order.profile_id, v_order.center_id, v_order.product_id, v_order.product_name,
        'count', v_count, v_count, v_expires, 'active'
    ) returning id into v_membership_id;

    insert into payments (
        center_id, profile_id, membership_id,
        sale_type, revenue_category,
        card_amount, cash_amount, transfer_amount, point_amount,
        total_amount, unpaid_amount, pg_transaction_id, paid_at, status, memo
    ) values (
        v_order.center_id, v_order.profile_id, v_membership_id,
        'new', 'membership',
        v_order.amount, 0, 0, 0,
        v_order.amount, 0, p_provider_ref, now(), 'paid',
        '테스트 결제(Mock Provider) 자동 발급'
    );

    update orders set status = 'done' where id = p_order_id;

    return json_build_object(
        'already_done', false,
        'membership_id', v_membership_id,
        'amount', v_order.amount
    );
end;
$$;

COMMIT;
