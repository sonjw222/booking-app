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

    if v_order.status = 'cancelled' then
        raise exception '취소된 주문은 발급할 수 없어요';
    end if;
    -- fulfill_nicepay_guard begin
    if v_order.payment_provider = 'nicepay' then
        raise exception 'NICEPAY 결제 주문은 PG 승인으로만 발급할 수 있어요';
    end if;
    -- fulfill_nicepay_guard end

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

    v_count := null;
    v_expires := null;
    v_starts := (now() at time zone 'Asia/Seoul')::date;

    if v_order.product_id is not null then
        select * into v_product from products where id = v_order.product_id;
        if found then
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
                    when 'days' then ((now() + (coalesce(v_product.expiry_days, 0) || ' days')::interval) at time zone 'Asia/Seoul')::date
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

    if v_order.member_coupon_id is not null then
        update member_coupons
           set status = 'used', used_at = now(), order_id = v_order.id
         where id = v_order.member_coupon_id;
    end if;

    perform ensure_center_member(v_order.center_id, v_order.profile_id);

    v_auto := _order_auto_book(v_membership_id, coalesce(v_order.auto_book, false));

    update orders
       set status = 'done',
           paid_at = now()
     where id = p_order_id;

    return (
        jsonb_build_object(
            'already_done', false,
            'membership_id', v_membership_id,
            'amount', v_order.amount
        ) || v_auto
    )::json;
end;
$function$;
