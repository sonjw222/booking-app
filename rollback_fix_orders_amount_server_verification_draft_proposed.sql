-- ============================================================
-- ROLLBACK for fix_orders_amount_server_verification_draft_proposed.sql
--
-- fulfill_order()/confirm_test_payment()를 재검증 없는 원래 정의로 되돌리고,
-- create_order_secure()를 제거하고, orders.verified 컬럼도 제거한다.
--
-- ⚠ 이 롤백을 실행하면 SEC-118(orders.amount 클라이언트 신뢰 문제)이 다시
-- 열린다 — 회원이 임의 금액으로 주문을 만들 수 있는 상태로 되돌아간다. 또한
-- lib/orders.ts가 create_order_secure()를 호출하도록 이미 바뀐 상태에서 이
-- 롤백만 실행하면(코드는 그대로 두고) 앱이 존재하지 않는 RPC를 호출해 완전히
-- 깨진다 — 코드 변경도 함께 되돌리지 않는 한 이 SQL 롤백만 단독 실행하지 말 것.
--
-- 여러 번 실행해도 안전.
-- ============================================================

BEGIN;

create or replace function fulfill_order(p_order_id uuid)
returns json
language plpgsql
security definer
as $$
declare
    v_order      record;
    v_product    record;
    v_membership_id uuid;
    v_count      int;
    v_kind       text;
    v_expires    date;
begin
    select * into v_order from orders where id = p_order_id for update;
    if not found then
        raise exception '주문을 찾을 수 없어요';
    end if;

    if not (v_order.center_id in (select my_managed_center_ids()) or is_platform_admin()) then
        raise exception '이 주문을 처리할 권한이 없어요';
    end if;

    if v_order.status = 'done' then
        return json_build_object('already_done', true);
    end if;

    v_count := null; v_kind := 'pass';
    if v_order.product_id is not null then
        select * into v_product from products where id = v_order.product_id;
        if found then
            v_count := v_product.total_count;
            v_kind := v_product.product_kind;
        end if;
    end if;

    v_expires := (now() + interval '60 days')::date;

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
        card_amount, cash_amount, transfer_amount, point_amount, direct_amount,
        total_amount, unpaid_amount, paid_at, status, memo
    ) values (
        v_order.center_id, v_order.profile_id, v_membership_id,
        'new', 'membership',
        case when v_order.pay_method in ('card','kakao','toss') then v_order.amount else 0 end,
        0,
        case when v_order.pay_method = 'transfer' then v_order.amount else 0 end,
        0,
        case when v_order.pay_method = 'direct' then v_order.amount else 0 end,
        v_order.amount, 0, now(), 'paid',
        '앱 주문 자동 발급'
    );

    perform ensure_center_member(v_order.center_id, v_order.profile_id);

    if coalesce(v_order.auto_book, false) then
        begin
            perform auto_book_membership(v_membership_id);
        exception when others then
            null;
        end;
    end if;

    update orders set status = 'done', paid_at = now() where id = p_order_id;

    return json_build_object(
        'already_done', false,
        'membership_id', v_membership_id,
        'amount', v_order.amount
    );
end;
$$;

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

drop function if exists create_order_secure(uuid, text, text, int, boolean, text);

alter table orders drop column if exists verified;

COMMIT;

-- ============================================================
-- 완료. fulfill_order()/confirm_test_payment() 원래 정의로 복원, create_order_secure()
-- 제거, orders.verified 컬럼 제거.
-- ============================================================
