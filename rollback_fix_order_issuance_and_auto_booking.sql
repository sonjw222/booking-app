-- ============================================================
-- fix_order_issuance_and_auto_booking.sql 롤백 — 적용 직전 "라이브 정의"(2026-10-01 조회)로 되돌린다.
-- 주의: 되돌리면 (1) 하드코딩 쿠폰 WELCOME/FIGURE10 판정이 함수에 다시 생기고, (2) 직접결제 승인이
--   다시 "할인 후 금액 != 상품 원가"로 거절되며, (3) 자동예약은 products.auto_book_days만 보고 만료일을
--   UTC 날짜로 비교하는 옛 동작으로 돌아간다. 추가된 컬럼(memberships.selected_size,
--   auto_book_requested)은 데이터 보존을 위해 기본적으로 지우지 않는다(맨 아래 주석 참고).
-- ============================================================

-- 새 함수가 의존하는 순서의 역순으로 되돌린다.
drop function if exists unplaced_weekday_passes(uuid);
CREATE OR REPLACE FUNCTION public.unplaced_weekday_passes(p_center_id uuid)
 RETURNS TABLE(membership_id uuid, profile_id uuid, member_name text, product_name text, total_count integer, remaining_count integer, auto_book_days integer[], expires_at date, purchased_at timestamp with time zone)
 LANGUAGE sql
 SECURITY DEFINER
AS $function$
    select
        m.id,
        m.profile_id,
        coalesce(p.name, '(이름 없음)'),
        m.product_name,
        m.total_count,
        m.remaining_count,
        pr.auto_book_days,
        m.expires_at,
        m.created_at
    from memberships m
    join products pr on pr.id = m.product_id
    left join profiles p on p.id = m.profile_id
    where m.center_id = p_center_id
      and m.status = 'active'
      and pr.auto_book_days is not null
      and array_length(pr.auto_book_days, 1) > 0
      and coalesce(m.remaining_count, 0) > 0          -- 아직 배치 못 한 횟수가 남음
      and (m.center_id in (select my_managed_center_ids()) or is_platform_admin())
    order by m.created_at asc;                        -- 먼저 구매한 순
$function$;

CREATE OR REPLACE FUNCTION public.auto_book_membership(p_membership_id uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_mem     record;
    v_days    int[];
    v_left    int;
    v_booked  int := 0;
    v_class   record;
    v_taken   int;
    v_used_dates date[] := '{}';
    v_cdate   date;
    v_book_deadline timestamptz;
    v_open_deadline timestamptz;
    v_daily_enabled boolean;
    v_daily_limit   int;
    v_daily_count   int;
    v_pmc_enabled boolean;
    v_pmc_limit   int;
    v_concurrent  int;
begin
    select * into v_mem from memberships where id = p_membership_id for update;
    if not found then
        raise exception '수강권을 찾을 수 없어요';
    end if;

    if not (v_mem.center_id in (select my_managed_center_ids()) or is_platform_admin()) then
        raise exception '이 수강권을 자동예약 처리할 권한이 없어요';
    end if;

    select auto_book_days into v_days from products where id = v_mem.product_id;
    if v_days is null or array_length(v_days, 1) is null then
        return json_build_object('booked', 0, 'reason', 'not_weekday_pass');
    end if;

    v_left := coalesce(v_mem.remaining_count, 0);
    if v_left <= 0 then
        return json_build_object('booked', 0, 'reason', 'no_remaining');
    end if;

    select daily_book_limit_enabled, daily_book_limit,
           private_max_concurrent_enabled, private_max_concurrent
      into v_daily_enabled, v_daily_limit, v_pmc_enabled, v_pmc_limit
    from center_settings where center_id = v_mem.center_id;

    for v_class in
        select c.id, c.capacity, c.start_time, c.end_time, c.class_format,
               c.booking_deadline_min, c.center_id, c.title, c.pass_selection_mode,
               (c.start_time at time zone 'Asia/Seoul')::date as class_date,
               (c.start_time at time zone 'Asia/Seoul')::time as class_time,
               extract(dow from (c.start_time at time zone 'Asia/Seoul'))::int as class_dow
        from classes c
        where c.center_id = v_mem.center_id
          and c.status = 'open'
          and c.start_time > now()
          and (v_mem.expires_at is null or c.start_time::date <= v_mem.expires_at)
          and (v_mem.starts_at is null or c.start_time::date >= v_mem.starts_at)
          and extract(dow from (c.start_time at time zone 'Asia/Seoul'))::int = any(v_days)
          and (
                c.pass_selection_mode = 'all'
                or v_mem.product_id in (select cap.product_id from class_allowed_products cap where cap.class_id = c.id)
              )
          and (
                (
                    c.pass_selection_mode = 'selected'
                    and exists (
                        select 1 from class_allowed_products cap
                        where cap.class_id = c.id and cap.product_id = v_mem.product_id
                    )
                )
                or v_mem.product_id is null
                or not exists (select 1 from membership_schedule_rules r where r.product_id = v_mem.product_id)
                or exists (
                    select 1 from membership_schedule_rules r
                    where r.product_id = v_mem.product_id
                      and (r.day_of_week is null or r.day_of_week = extract(dow from (c.start_time at time zone 'Asia/Seoul'))::int)
                      and (r.start_time is null or r.start_time = (c.start_time at time zone 'Asia/Seoul')::time)
                      and (r.class_title is null or c.title like '%' || r.class_title || '%')
                )
              )
          and not exists (
                select 1 from center_holidays ch
                where ch.center_id = c.center_id
                  and ch.holiday_date = (c.start_time at time zone 'Asia/Seoul')::date
              )
        order by c.start_time asc
    loop
        exit when v_left <= 0;
        v_cdate := v_class.class_date;
        if v_cdate = any(v_used_dates) then
            continue;
        end if;
        if exists (
            select 1 from reservations r
            join classes c2 on c2.id = r.class_id
            where r.profile_id = v_mem.profile_id
              and r.status in ('confirmed', 'waitlisted', 'attended')
              and (c2.start_time at time zone 'Asia/Seoul')::date = v_cdate
        ) then
            v_used_dates := array_append(v_used_dates, v_cdate);
            continue;
        end if;

        if v_class.booking_deadline_min is not null then
            v_book_deadline := v_class.start_time - make_interval(mins => v_class.booking_deadline_min);
        else
            v_book_deadline := calc_deadline(v_class.center_id, v_class.class_format, v_class.start_time, 'book');
            if v_book_deadline is null then
                v_book_deadline := v_class.start_time;
            end if;
        end if;
        if now() > v_book_deadline then
            continue;
        end if;

        v_open_deadline := calc_deadline(v_class.center_id, v_class.class_format, v_class.start_time, 'open');
        if v_open_deadline is not null and now() < v_open_deadline then
            continue;
        end if;

        if v_class.class_format = 'private' and coalesce(v_pmc_enabled, false) and v_pmc_limit is not null then
            select count(*) into v_concurrent
            from classes c2
            join reservations r2 on r2.class_id = c2.id and r2.status = 'confirmed'
            where c2.center_id = v_mem.center_id
              and c2.class_format = 'private'
              and c2.id <> v_class.id
              and c2.status <> 'cancelled'
              and c2.start_time < v_class.end_time
              and c2.end_time > v_class.start_time;

            if v_concurrent >= v_pmc_limit then
                continue;
            end if;
        end if;

        if coalesce(v_daily_enabled, false) and v_daily_limit is not null then
            select count(*) into v_daily_count
            from reservations r
            join classes c on c.id = r.class_id
            where r.profile_id = v_mem.profile_id
              and c.center_id = v_mem.center_id
              and (c.start_time at time zone 'Asia/Seoul')::date = v_cdate
              and r.status in ('confirmed', 'waitlisted');

            if v_daily_count >= v_daily_limit then
                v_used_dates := array_append(v_used_dates, v_cdate);
                continue;
            end if;
        end if;

        select count(*) into v_taken
        from reservations
        where class_id = v_class.id and status in ('confirmed', 'attended');
        if v_taken >= v_class.capacity then
            continue;
        end if;

        insert into reservations (class_id, profile_id, membership_id, status)
        values (v_class.id, v_mem.profile_id, v_mem.id, 'confirmed');
        v_used_dates := array_append(v_used_dates, v_cdate);
        v_left := v_left - 1;
        v_booked := v_booked + 1;
    end loop;

    if v_booked > 0 then
        update memberships
           set remaining_count = remaining_count - v_booked
         where id = p_membership_id
           and remaining_count is not null;
    end if;

    return json_build_object('booked', v_booked);
end;
$function$;

CREATE OR REPLACE FUNCTION public.fulfill_order(p_order_id uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_order      record;
    v_product    record;
    v_membership_id uuid;
    v_count      int;
    v_kind       text;
    v_expires    date;
    v_starts     date;
    v_rm         record;
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

    if not coalesce(v_order.verified, false) then
        if v_order.product_id is null or v_order.amount <> (select price from products where id = v_order.product_id) then
            raise exception '주문 금액을 확인할 수 없어요. 상품 가격과 다릅니다 — 센터에서 직접 확인해주세요.';
        end if;
    end if;

    v_count := null; v_kind := 'pass'; v_expires := null; v_starts := current_date;
    if v_order.product_id is not null then
        select * into v_product from products where id = v_order.product_id;
        if found then
            v_count := case when v_product.unlimited_pass then null else v_product.total_count end;
            v_kind := v_product.product_kind;
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
        bound_day_of_week, bound_start_time
    ) values (
        v_order.profile_id, v_order.center_id, v_order.product_id, v_order.product_name,
        'count', v_count, v_count, v_expires, v_starts, 'active',
        v_order.selected_day_of_week, v_order.selected_start_time
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
$function$;

CREATE OR REPLACE FUNCTION public._issue_membership_and_record_payment(p_order orders, p_provider_ref text, p_memo text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
    v_product           record;
    v_membership_id     uuid;
    v_count             int;
    v_expires           date;
    v_starts            date;
    v_rm                record;
    v_verified_discount int;
    v_expected_amount   int;
    v_points_verified   boolean;
    v_coupon            record;
    v_member_coupon     record;
begin
    v_count := null;
    v_expires := null;
    v_starts := current_date;
    if p_order.product_id is not null then
        select * into v_product from products where id = p_order.product_id;
        if found then
            -- [FIX] 구매 자격 재검증(요청 5/17번) — 주문 생성 시점(orders INSERT RLS)에서
            -- 이미 확인했지만, 확정 시점 사이에 공개범위가 바뀌었을 수 있으므로 여기서
            -- 다시 한번 확인한다. UI 숨김이나 주문 생성 차단을 우회해 이 함수를 직접
            -- 호출할 방법은 없지만(confirm_test_payment/confirm_real_payment를 거쳐야
            -- 하고 둘 다 소유자 검증을 함), 그래도 이 함수 자체가 "최종 서버 검증
            -- 지점"이라는 원칙을 지키기 위해 독립적으로 재확인한다.
            if not member_can_purchase_product(p_order.product_id, p_order.profile_id) then
                raise exception '이 수강권을 구매할 수 있는 대상이 아닙니다.';
            end if;

            v_count := case when v_product.unlimited_pass then null else v_product.total_count end;
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

            v_verified_discount := case p_order.coupon_code
                when 'WELCOME' then 5000
                when 'FIGURE10' then 10000
                else 0
            end;

            -- [FIX] 실제 member_coupon 기반 할인(요청 16번) — 클라이언트가 보낸 할인율/
            -- 할인금액/최종금액은 절대 신뢰하지 않고, member_coupon_id로부터 서버가
            -- 처음부터 다시 계산한다.
            if p_order.member_coupon_id is not null then
                -- [NEW, 2026-09-19] 상품 자체가 "쿠폰 적용 불가"면 쿠폰 소유/유효성과
                -- 무관하게 여기서 바로 차단한다 — 쿠폰 쪽 applies_to가 뭐든 이 상품의
                -- 설정이 우선한다.
                if not coalesce(v_product.coupon_eligible, true) then
                    raise exception '이 수강권은 쿠폰을 적용할 수 없어요.';
                end if;

                select mc.*, c.discount_type, c.discount_value, c.max_discount_amount,
                       c.minimum_order_amount, c.applies_to, c.valid_from, c.valid_until,
                       c.status as coupon_status, c.center_id as coupon_center_id
                  into v_member_coupon
                  from member_coupons mc
                  join coupons c on c.id = mc.coupon_id
                 where mc.id = p_order.member_coupon_id
                 for update;

                if not found then
                    raise exception '쿠폰을 찾을 수 없어요';
                end if;
                -- 쿠폰 소유자 확인(다른 회원 쿠폰 도용 차단, 요청 24-12번)
                if not exists (
                    select 1 from center_members cm
                    where cm.id = v_member_coupon.center_member_id
                      and cm.profile_id = p_order.profile_id
                ) then
                    raise exception '본인에게 지급된 쿠폰만 사용할 수 있어요';
                end if;
                -- 센터 일치(다른 센터 쿠폰 차단, 요청 24-13번)
                if v_member_coupon.coupon_center_id is distinct from p_order.center_id then
                    raise exception '이 센터에서 사용할 수 없는 쿠폰이에요';
                end if;
                if v_member_coupon.status <> 'available' then
                    raise exception '사용할 수 없는 쿠폰이에요(이미 사용됐거나 만료/회수됨)';
                end if;
                if v_member_coupon.valid_from is not null and now() < v_member_coupon.valid_from then
                    raise exception '아직 사용할 수 없는 쿠폰이에요';
                end if;
                if v_member_coupon.valid_until is not null and now() > v_member_coupon.valid_until then
                    raise exception '유효기간이 지난 쿠폰이에요';
                end if;
                if v_member_coupon.applies_to = 'selected' and not exists (
                    select 1 from coupon_products where coupon_id = v_member_coupon.coupon_id and product_id = p_order.product_id
                ) then
                    raise exception '이 수강권에는 사용할 수 없는 쿠폰이에요';
                end if;
                if v_member_coupon.minimum_order_amount is not null and v_product.price < v_member_coupon.minimum_order_amount then
                    raise exception '최소 결제금액(%s원) 미만이라 쿠폰을 사용할 수 없어요', v_member_coupon.minimum_order_amount;
                end if;

                if v_member_coupon.discount_type = 'fixed' then
                    v_verified_discount := v_verified_discount + v_member_coupon.discount_value;
                else
                    v_verified_discount := v_verified_discount +
                        least(
                            (v_product.price * v_member_coupon.discount_value) / 100,
                            coalesce(v_member_coupon.max_discount_amount, v_product.price)
                        );
                end if;
            end if;

            if coalesce(p_order.points_used, 0) > 0 then
                select exists(
                    select 1 from point_transactions
                    where order_id = p_order.id
                      and profile_id = p_order.profile_id
                      and center_id = p_order.center_id
                      and amount = -p_order.points_used
                ) into v_points_verified;
                if not v_points_verified then
                    raise exception '포인트 사용 내역이 확인되지 않아 주문을 처리할 수 없어요(관리자 문의)';
                end if;
            end if;

            v_expected_amount := greatest(0, v_product.price - v_verified_discount - coalesce(p_order.points_used, 0));

            if p_order.amount is distinct from v_expected_amount then
                raise exception '주문 금액이 상품 가격과 일치하지 않아요(관리자 문의)';
            end if;
        end if;
    end if;

    update orders set status = 'paid', paid_at = now() where id = p_order.id;

    insert into memberships (
        profile_id, center_id, product_id, product_name,
        pass_type, total_count, remaining_count, expires_at, starts_at, status
    ) values (
        p_order.profile_id, p_order.center_id, p_order.product_id, p_order.product_name,
        'count', v_count, v_count, v_expires, v_starts, 'active'
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

    -- [FIX] 결제 성공 확정 시점에만 쿠폰을 used로 전환(요청 18번 — 선택 시점 X)
    if p_order.member_coupon_id is not null then
        update member_coupons
           set status = 'used', used_at = now(), order_id = p_order.id
         where id = p_order.member_coupon_id;
    end if;

    update orders set status = 'done' where id = p_order.id;

    return json_build_object('membership_id', v_membership_id, 'amount', p_order.amount);
end;
$function$;

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

    v_result := _issue_membership_and_record_payment(v_order, p_payment_key, '실 결제(' || v_order.payment_provider || ') 자동 발급');

    return json_build_object(
        'already_done', false,
        'membership_id', v_result->>'membership_id',
        'amount', (v_result->>'amount')::int
    );
end;
$function$;

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

    -- [SYNC-001] fulfill_order()와 동일하게 센터 회원 등록을 동기화한다.
    perform ensure_center_member(v_order.center_id, v_order.profile_id);

    return json_build_object(
        'already_done', false,
        'membership_id', v_result->>'membership_id',
        'amount', (v_result->>'amount')::int
    );
end;
$function$;

drop function if exists _order_auto_book(uuid, boolean);
drop function if exists _auto_book_membership_core(uuid, boolean);
drop function if exists _order_expected_amount(orders, boolean);

-- 데이터 손실을 피하려고 기본은 주석 처리 — 정말 지울 때만 주석을 풀어 실행:
-- alter table memberships drop column if exists selected_size;
-- alter table memberships drop column if exists auto_book_requested;
