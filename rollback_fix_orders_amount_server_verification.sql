-- ============================================================
-- fix_orders_amount_server_verification.sql 롤백
--
-- 주의: _issue_membership_and_record_payment()를 SEC-118 이전 버전(금액 검증 없음)으로
-- 되돌린다. orders.points_used 컬럼은 삭제하지 않는다 — 이미 쌓인 값을 보존하기 위해서다
-- (재적용 시 되살리기 쉽게). 컬럼까지 완전히 되돌리려면 아래 맨 끝의 주석 처리된 구문을
-- 직접 실행하세요.
-- ============================================================

BEGIN;

-- use_points()를 3-인자 버전으로 되돌린다(4-인자 버전 제거)
drop function if exists use_points(uuid, uuid, int, uuid);

create or replace function use_points(
    p_center_id uuid,
    p_profile_id uuid,
    p_amount int
)
returns json
language plpgsql
security definer
as $$
declare
    v_balance int;
begin
    if p_profile_id not in (select my_profile_ids()) then
        raise exception '본인 포인트만 사용할 수 있어요';
    end if;
    if p_amount <= 0 then
        return json_build_object('used', 0);
    end if;

    perform 1 from profiles where id = p_profile_id for update;

    select coalesce(sum(amount), 0) into v_balance
    from point_transactions
    where center_id = p_center_id and profile_id = p_profile_id;

    if v_balance < p_amount then
        raise exception '포인트가 부족해요';
    end if;

    insert into point_transactions (profile_id, center_id, amount, reason)
    values (p_profile_id, p_center_id, -p_amount, '결제 시 사용');

    return json_build_object('used', p_amount);
end;
$$;

create or replace function _issue_membership_and_record_payment(p_order orders, p_provider_ref text, p_memo text)
returns json
language plpgsql
security definer
as $$
declare
    v_product       record;
    v_membership_id uuid;
    v_count         int;
    v_expires       date;
begin
    v_count := null;
    if p_order.product_id is not null then
        select * into v_product from products where id = p_order.product_id;
        if found then
            v_count := v_product.total_count;
        end if;
    end if;

    v_expires := (now() + interval '60 days')::date;

    update orders set status = 'paid', paid_at = now() where id = p_order.id;

    insert into memberships (
        profile_id, center_id, product_id, product_name,
        pass_type, total_count, remaining_count, expires_at, status
    ) values (
        p_order.profile_id, p_order.center_id, p_order.product_id, p_order.product_name,
        'count', v_count, v_count, v_expires, 'active'
    ) returning id into v_membership_id;

    insert into payments (
        center_id, profile_id, membership_id,
        sale_type, revenue_category,
        card_amount, cash_amount, transfer_amount, point_amount,
        total_amount, unpaid_amount, pg_transaction_id, paid_at, status, memo
    ) values (
        p_order.center_id, p_order.profile_id, v_membership_id,
        'new', 'membership',
        p_order.amount, 0, 0, 0,
        p_order.amount, 0, p_provider_ref, now(), 'paid',
        p_memo
    );

    update orders set status = 'done' where id = p_order.id;

    return json_build_object('membership_id', v_membership_id, 'amount', p_order.amount);
end;
$$;

COMMIT;

-- orders.points_used / point_transactions.order_id 컬럼까지 완전히 되돌리려면
-- (기존 값 유실됨, 신중히):
-- alter table orders drop column if exists points_used;
-- alter table point_transactions drop column if exists order_id;
