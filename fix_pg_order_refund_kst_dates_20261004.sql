-- ============================================================
-- PG/주문/환불 날짜 KST 정합성(2026-10-04) — 2026-10-03에 "결제/주문/환불 lifecycle이라 별도 batch"로 남겨 둔 세 함수의 DB TimeZone(UTC) 의존 날짜만 KST로 정리한다.
-- 기준: Production 라이브 함수 정의(읽기 전용 pg_get_functiondef)이며 저장소의 최신 정의 계보와 일치함을 확인했다 —
--   _issue_membership_and_record_payment = fix_order_issuance_and_auto_booking.sql, fulfill_order = fix_order_point_lifecycle.sql, _refund_membership_core = fix_pg_payment_lifecycle.sql.
--   오래된 파일의 정의를 복사하지 않았고, 아래 5줄(3개 함수)만 바꿨다. 나머지(검증/쿠폰/포인트/자동예약/환불 정책/PG lock)는 라이브 정의 그대로다.
--
-- 날짜 문제(DB TimeZone이 UTC라 KST 00:00~08:59에 하루 어긋남):
--   A. _issue_membership_and_record_payment: v_starts := current_date → KST 오늘 / days형 만료 (now() + N days)::date → ((now() + N days) at time zone 'Asia/Seoul')::date
--   B. fulfill_order: 위와 동일(시작일, days형 만료)
--   C. _refund_membership_core: 환불 후 "다른 활성 수강권이 남았는지" 판정의 m.expires_at >= current_date → KST 오늘 (center_members.status='expired' 전환 여부에 쓰임)
-- 보존: days형 N일의 inclusive 의미(KST 오늘 + N일), rolling_month(이미 KST: calc_rolling_month_dates), date/무제한 모드, 금액 검증, 쿠폰/포인트, 자동예약, 환불 정책/PG lock — 변경 없음.
-- 보안 계약 보존: 시그니처/SECURITY DEFINER/search_path 불변. 내부 helper 2개는 owner 외 실행 불가(PUBLIC/anon/authenticated/service_role), fulfill_order는 authenticated만 실행 — create or replace는 권한을 유지하며 아래에서 현재 상태를 명시적으로 재확인(동일 값)한다.
-- 이 세션에서는 production에 실행하지 않았습니다. 적용 전/후 verify_pg_order_refund_kst_dates_20261004.sql(읽기 전용)로 확인하세요.
-- ============================================================
begin;

-- A. 결제 확정 발급(PG/테스트 결제 공통 helper)
CREATE OR REPLACE FUNCTION public._issue_membership_and_record_payment(p_order orders, p_provider_ref text, p_memo text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_product           record;
    v_membership_id     uuid;
    v_count             int;
    v_expires           date;
    v_starts            date;
    v_rm                record;
    v_expected_amount   int;
    v_auto              jsonb;
begin
    v_count := null;
    v_expires := null;
    v_starts := (now() at time zone 'Asia/Seoul')::date;   -- KST 오늘(DB TimeZone 무관)
    if p_order.product_id is not null then
        select * into v_product from products where id = p_order.product_id;
        if found then
            if not member_can_purchase_product(p_order.product_id, p_order.profile_id) then
                raise exception '이 수강권을 구매할 수 있는 대상이 아닙니다.';
            end if;

            -- 횟수 선택형 상품: 주문 snapshot의 selected_count를 발급 횟수로(PG에서 amount를 1회분만 결제하고
            -- 12회를 받는 식의 조작 방지 — 금액은 아래 _order_expected_amount가 같은 snapshot으로 검증).
            if coalesce(v_product.purchase_count_selectable, false) then
                if p_order.selected_count is null or p_order.selected_count < 1 then
                    raise exception '구매 횟수 정보가 없는 주문이에요(관리자 문의)';
                end if;
                v_count := p_order.selected_count;
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

            -- 직접결제(fulfill_order)와 같은 공식 — 쿠폰/포인트를 서버가 검증해 기대금액을 계산
            v_expected_amount := _order_expected_amount(p_order, true);
            if p_order.amount is distinct from v_expected_amount then
                raise exception '주문 금액이 상품 가격과 일치하지 않아요(관리자 문의)';
            end if;
        end if;
    end if;

    update orders set status = 'paid', paid_at = now() where id = p_order.id;

    insert into memberships (
        profile_id, center_id, product_id, product_name,
        pass_type, total_count, remaining_count, expires_at, starts_at, status,
        bound_day_of_week, bound_start_time, selected_size, auto_book_requested
    ) values (
        p_order.profile_id, p_order.center_id, p_order.product_id, p_order.product_name,
        'count', v_count, v_count, v_expires, v_starts, 'active',
        p_order.selected_day_of_week, p_order.selected_start_time, p_order.selected_size,
        coalesce(p_order.auto_book, false)
    ) returning id into v_membership_id;

    insert into payments (
        center_id, profile_id, membership_id, order_id,
        sale_type, revenue_category,
        card_amount, cash_amount, transfer_amount, point_amount,
        total_amount, unpaid_amount, pg_transaction_id, paid_at, status, memo
    ) values (
        p_order.center_id, p_order.profile_id, v_membership_id, p_order.id,
        'new', 'membership',
        p_order.amount, 0, 0, 0,
        p_order.amount, 0, p_provider_ref, now(), 'paid',
        p_memo
    );

    if p_order.member_coupon_id is not null then
        update member_coupons
           set status = 'used', used_at = now(), order_id = p_order.id
         where id = p_order.member_coupon_id;
    end if;

    v_auto := _order_auto_book(v_membership_id, coalesce(p_order.auto_book, false));

    update orders set status = 'done' where id = p_order.id;

    return (jsonb_build_object('membership_id', v_membership_id, 'amount', p_order.amount) || v_auto)::json;
end;
$function$;

-- B. 직접결제/앱 주문 발급
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

    v_count := null; v_expires := null; v_starts := (now() at time zone 'Asia/Seoul')::date;   -- KST 오늘(DB TimeZone 무관)
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

-- C. 환불 코어
CREATE OR REPLACE FUNCTION public._refund_membership_core(p_membership_id uuid, p_account_id uuid, p_allow_pg boolean, p_skip_time_check boolean)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
      and (m.expires_at is null or m.expires_at >= (now() at time zone 'Asia/Seoul')::date);

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

-- 실행 권한: 현재 Production 상태와 동일하게 재명시(내부 helper는 owner 외 직접 실행 불가, fulfill_order는 authenticated만)
revoke all on function public._issue_membership_and_record_payment(orders, text, text) from public, anon, authenticated, service_role;
revoke all on function public._refund_membership_core(uuid, uuid, boolean, boolean) from public, anon, authenticated, service_role;
revoke all on function public.fulfill_order(uuid) from public, anon, service_role;
grant execute on function public.fulfill_order(uuid) to authenticated;

commit;
