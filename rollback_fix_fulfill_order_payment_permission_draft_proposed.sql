-- ============================================================
-- ROLLBACK for fix_fulfill_order_payment_permission_draft_proposed.sql
--
-- fulfill_order()의 권한 체크를 my_managed_center_ids() 기반으로 되돌린다(SEC-116
-- 이전 상태). SEC-118(verified 재검증)과 다른 로직은 전부 그대로 유지 — 이 롤백은
-- 권한 체크 한 줄만 되돌린다.
--
-- ⚠ 이 롤백을 실행하면 SEC-116(그 센터 매니저면 세분권한 없이도 주문 처리 가능)이
-- 다시 열린다.
--
-- 여러 번 실행해도 안전.
-- ============================================================

BEGIN;

create or replace function fulfill_order(p_order_id uuid)
returns json
language plpgsql
security definer
set search_path = public
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

    if not coalesce(v_order.verified, false) then
        if v_order.product_id is null or v_order.amount <> (select price from products where id = v_order.product_id) then
            raise exception '주문 금액을 확인할 수 없어요. 상품 가격과 다릅니다 — 센터에서 직접 확인해주세요.';
        end if;
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

COMMIT;

-- ============================================================
-- 완료. fulfill_order()의 권한 체크가 my_managed_center_ids() 기반으로 복원됨.
-- ============================================================
