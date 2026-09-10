-- ============================================================
-- "매달 자동으로 그 달까지" 수강권(rolling_month) 신규 기능
--
-- 배경(사용자 요청, 2026-09-10): "9월 수강권"처럼 매달 새 상품을 만들어야 하는 번거로움을
-- 없애기 위해, 상품 하나만 만들어두면 구매 시점에 따라 자동으로 "이번 달" 또는 "다음 달"
-- 수강권으로 배정되는 네 번째 만료 방식을 추가한다(기존 products.expiry_mode는
-- none/days/date 3가지 — add_product_expiry_options.sql 참고).
--
-- 규칙: 상품에 "컷오프 일자"(rolling_month_cutoff_day, 1~31)를 하나 정해두면 —
--   - 구매일(KST)의 "일"이 컷오프보다 작으면 → 이번 달이 대상 월
--   - 컷오프 이상이면 → 다음 달이 대상 월
--   - 만료일 = 대상 월의 말일
-- 예: 컷오프=15 → 4/20 구매(20≥15)는 5월 대상, 5/10 구매(10<15)도 5월 대상,
--     5/15 구매(15≥15)는 6월 대상.
--
-- [핵심 설계 포인트, 사용자와 논의로 확정] 다음 달로 넘어간 경우, 이 수강권은 "다음 달이
-- 되기 전까지는 쓸 수 없어야" 의도한 동작이 완성된다(안 그러면 5/15에 사서 받은 "6월
-- 수강권"으로 5/17 수업을 예약할 수 있게 돼버려 의미가 없어짐) — 그래서 memberships에
-- "언제부터 쓸 수 있는지"(starts_at)를 새로 추가한다. 이 필드는 기존 3가지 만료방식에는
-- 전혀 영향 없음(계속 null = 제한 없음, 구매 즉시 사용 가능).
--
-- 다만 센터가 "다음 달로 넘어가도 즉시 써도 된다"를 선택할 수 있게
-- rolling_month_allow_early_use 토글도 같이 둔다(기본 false = 엄격하게 다음 달부터만).
--
-- 영향받는 함수(모두 라이브 정의 기준으로 CREATE OR REPLACE, drift 없음 —
-- pg_get_functiondef로 직접 확인 후 작성):
--   - fulfill_order() / _issue_membership_and_record_payment(): 만료일/시작일 계산에
--     rolling_month 분기 추가.
--   - reserve_class() / reserve_with_membership(): 사용 가능 수강권 조회 조건에
--     starts_at 체크 추가(기존 expires_at 체크와 나란히).
--   - usable_memberships_for_classes(): 회원 예약화면의 "사용 가능 수강권 목록"에도
--     동일하게 starts_at 체크 추가(아직 시작 안 한 수강권은 목록에서 안 보임 — 만료된
--     수강권이 이미 안 보이는 것과 동일한 패턴).
--   - auto_book_membership(): 요일반 자동예약 대상 수업 필터에도 starts_at 체크 추가.
--
-- 파일 전체를 SQL Editor에 붙여넣고 Run 하세요. 여러 번 실행해도 안전.
-- ============================================================

-- ------------------------------------------------------------
-- [1] 스키마: products에 컷오프 일자 + 즉시사용 허용 토글, memberships에 시작일
-- ------------------------------------------------------------
alter table products add column if not exists rolling_month_cutoff_day int;
alter table products add column if not exists rolling_month_allow_early_use boolean not null default false;

alter table products drop constraint if exists products_rolling_month_cutoff_day_check;
alter table products add constraint products_rolling_month_cutoff_day_check
    check (rolling_month_cutoff_day is null or (rolling_month_cutoff_day between 1 and 31));

alter table products drop constraint if exists products_expiry_mode_check;
alter table products add constraint products_expiry_mode_check
    check (expiry_mode in ('none', 'days', 'date', 'rolling_month'));

comment on column products.rolling_month_cutoff_day is
    '매달 자동 갱신(expiry_mode=rolling_month) 상품의 컷오프 일자(1~31). 구매일(KST)의
     "일"이 이 값보다 작으면 이번 달, 이 값 이상이면 다음 달이 대상 월이 된다';
comment on column products.rolling_month_allow_early_use is
    'rolling_month 상품에서 대상 월이 다음 달로 넘어간 경우에도 구매 즉시 사용을 허용할지.
     false(기본)면 memberships.starts_at이 대상 월 1일로 찍혀 그 전까지는 예약에 못 쓴다';

alter table memberships add column if not exists starts_at date;
comment on column memberships.starts_at is
    '이 수강권을 실제로 예약에 쓸 수 있는 시작일(KST). null=제한 없음(구매 즉시 사용
     가능, 기존 모든 만료방식은 계속 이 값이 null). rolling_month 상품이 대상 월을
     다음 달로 넘겼고 allow_early_use가 꺼져있을 때만 그 달 1일로 채워진다';

-- ------------------------------------------------------------
-- [2] 공용 헬퍼: 구매 시각 + 컷오프로 대상 월의 시작일/말일 계산
-- ------------------------------------------------------------
create or replace function calc_rolling_month_dates(p_purchase_ts timestamptz, p_cutoff_day int)
returns table(starts_at date, expires_at date)
language sql
stable
as $$
    select
        case
            when extract(day from (p_purchase_ts at time zone 'Asia/Seoul')) >= p_cutoff_day
                then (date_trunc('month', (p_purchase_ts at time zone 'Asia/Seoul')::date) + interval '1 month')::date
            else date_trunc('month', (p_purchase_ts at time zone 'Asia/Seoul')::date)::date
        end as starts_at,
        case
            when extract(day from (p_purchase_ts at time zone 'Asia/Seoul')) >= p_cutoff_day
                then (date_trunc('month', (p_purchase_ts at time zone 'Asia/Seoul')::date) + interval '2 months' - interval '1 day')::date
            else (date_trunc('month', (p_purchase_ts at time zone 'Asia/Seoul')::date) + interval '1 month' - interval '1 day')::date
        end as expires_at;
$$;

-- ------------------------------------------------------------
-- [3] fulfill_order() — rolling_month 분기 추가(그 외 로직 전부 라이브 정의와 동일)
-- ------------------------------------------------------------
create or replace function fulfill_order(p_order_id uuid)
returns json
language plpgsql
security definer
set search_path to 'public'
as $$
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

    v_count := null; v_kind := 'pass'; v_expires := null; v_starts := null;
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
        pass_type, total_count, remaining_count, expires_at, starts_at, status
    ) values (
        v_order.profile_id, v_order.center_id, v_order.product_id, v_order.product_name,
        'count', v_count, v_count, v_expires, v_starts, 'active'
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

-- ------------------------------------------------------------
-- [4] _issue_membership_and_record_payment() — 동일한 rolling_month 분기 추가
--     (confirm_test_payment/confirm_real_payment 공용 헬퍼 — 여기 한 곳만 고치면
--     두 결제 경로 모두 적용됨. SEC-118 금액검증 로직은 전혀 안 건드림)
-- ------------------------------------------------------------
create or replace function _issue_membership_and_record_payment(p_order orders, p_provider_ref text, p_memo text)
returns json
language plpgsql
security definer
as $$
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
begin
    v_count := null;
    v_expires := null;
    v_starts := null;
    if p_order.product_id is not null then
        select * into v_product from products where id = p_order.product_id;
        if found then
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

-- ------------------------------------------------------------
-- [5] reserve_class() — 사용 가능 수강권 조회에 starts_at 체크 추가
-- ------------------------------------------------------------
create or replace function reserve_class(p_class_id uuid, p_profile_id uuid DEFAULT NULL::uuid)
returns json
language plpgsql
security definer
set search_path to 'public'
as $$
declare
    v_profile_id    uuid;
    v_class         record;
    v_membership    record;
    v_confirmed     int;
    v_status        text;
    v_wait_order    int;
    v_reservation_id uuid;
    v_day_of_week   int;
    v_local_date    date;
    v_local_time    time;
begin
    if p_profile_id is not null then
        select id into v_profile_id from profiles
        where id = p_profile_id and account_id = my_account_id();
    else
        select id into v_profile_id from profiles
        where account_id = my_account_id() and is_primary = true
        limit 1;
    end if;
    if v_profile_id is null then
        raise exception '로그인이 필요하거나 프로필을 찾을 수 없어요';
    end if;

    select * into v_class from classes where id = p_class_id for update;
    if not found then
        raise exception '수업을 찾을 수 없어요';
    end if;

    v_local_date := (v_class.start_time at time zone 'Asia/Seoul')::date;
    v_local_time := (v_class.start_time at time zone 'Asia/Seoul')::time;
    v_day_of_week := extract(dow from (v_class.start_time at time zone 'Asia/Seoul'))::int;

    if v_class.status = 'cancelled' then
        raise exception '폐강된 수업이에요';
    end if;
    if v_class.status = 'closed' then
        raise exception '예약이 마감된 수업이에요';
    end if;

    if not exists (
        select 1 from centers where id = v_class.center_id and status = 'approved'
    ) then
        raise exception '아직 승인되지 않은 센터예요';
    end if;

    if now() >= v_class.start_time then
        raise exception '수업이 시작되었습니다.';
    end if;

    declare
        v_book_deadline timestamptz;
    begin
        if v_class.booking_deadline_min is not null then
            v_book_deadline := v_class.start_time - make_interval(mins => v_class.booking_deadline_min);
        else
            v_book_deadline := calc_deadline(v_class.center_id, v_class.class_format, v_class.start_time, 'book');
            if v_book_deadline is null then
                v_book_deadline := v_class.start_time;
            end if;
        end if;
        if now() > v_book_deadline then
            raise exception '예약 마감시간이 지났어요';
        end if;
    end;

    declare
        v_open_deadline timestamptz;
    begin
        v_open_deadline := calc_deadline(v_class.center_id, v_class.class_format, v_class.start_time, 'open');
        if v_open_deadline is not null and now() < v_open_deadline then
            raise exception '아직 예약이 열리지 않았어요';
        end if;
    end;

    if v_class.booking_deadline_min is null and v_local_date = (now() at time zone 'Asia/Seoul')::date then
        declare
            v_allow_same_day boolean;
        begin
            select allow_same_day_booking into v_allow_same_day
            from center_settings where center_id = v_class.center_id;
            if coalesce(v_allow_same_day, true) = false then
                raise exception '당일 예약은 허용되지 않아요';
            end if;
        end;
    end if;

    declare
        v_daily_enabled boolean;
        v_daily_limit   int;
        v_daily_count   int;
    begin
        select daily_book_limit_enabled, daily_book_limit
          into v_daily_enabled, v_daily_limit
        from center_settings where center_id = v_class.center_id;

        if coalesce(v_daily_enabled, false) and v_daily_limit is not null then
            select count(*) into v_daily_count
            from reservations r
            join classes c on c.id = r.class_id
            where r.profile_id = v_profile_id
              and c.center_id = v_class.center_id
              and (c.start_time at time zone 'Asia/Seoul')::date = v_local_date
              and r.status in ('confirmed', 'waitlisted');

            if v_daily_count >= v_daily_limit then
                raise exception '하루 예약 가능 횟수(%회)를 초과했어요', v_daily_limit;
            end if;
        end if;
    end;

    if exists (
        select 1 from center_holidays
        where center_id = v_class.center_id
          and holiday_date = v_local_date
    ) then
        raise exception '센터 휴무일이라 예약할 수 없어요';
    end if;

    if v_class.class_format = 'private' then
        declare
            v_pmc_enabled boolean;
            v_pmc_limit   int;
            v_concurrent  int;
        begin
            select private_max_concurrent_enabled, private_max_concurrent
              into v_pmc_enabled, v_pmc_limit
            from center_settings where center_id = v_class.center_id;

            if coalesce(v_pmc_enabled, false) and v_pmc_limit is not null then
                select count(*) into v_concurrent
                from classes c2
                join reservations r2 on r2.class_id = c2.id and r2.status = 'confirmed'
                where c2.center_id = v_class.center_id
                  and c2.class_format = 'private'
                  and c2.id <> v_class.id
                  and c2.status <> 'cancelled'
                  and c2.start_time < v_class.end_time
                  and c2.end_time > v_class.start_time;

                if v_concurrent >= v_pmc_limit then
                    raise exception '같은 시간대에 진행 가능한 프라이빗 수업이 이미 다 찼어요(최대 %건)', v_pmc_limit;
                end if;
            end if;
        end;
    end if;

    if exists (
        select 1 from reservations
        where class_id = p_class_id and profile_id = v_profile_id
          and status in ('confirmed', 'waitlisted')
    ) then
        raise exception '이미 예약(또는 대기)한 수업이에요';
    end if;

    select m.* into v_membership
    from memberships m
    where m.profile_id = v_profile_id
      and m.center_id = v_class.center_id
      and (m.remaining_count is null or m.remaining_count > 0)
      and (m.expires_at is null or m.expires_at >= current_date)
      and (m.starts_at is null or m.starts_at <= current_date)
      and is_membership_eligible_for_class(m.id, v_class.id)
    order by m.expires_at asc
    limit 1
    for update;

    if not found then
        raise exception '이 수업에 사용할 수 있는 수강권이 없어요 (잔여횟수/기간/예약조건을 확인해주세요)';
    end if;

    select count(*) into v_confirmed
    from reservations
    where class_id = p_class_id and status = 'confirmed';

    if v_confirmed < v_class.capacity then
        v_status := 'confirmed';
        update memberships set remaining_count = remaining_count - 1
        where id = v_membership.id;

        insert into reservations (class_id, profile_id, membership_id, status)
        values (p_class_id, v_profile_id, v_membership.id, 'confirmed')
        returning id into v_reservation_id;
    else
        if v_class.class_format = 'private' then
            raise exception '이미 다른 회원이 예약한 프라이빗 수업이에요';
        end if;

        declare
            v_weekly_limit int;
            v_week_start   date;
            v_week_count   int;
        begin
            select waitlist_weekly_limit into v_weekly_limit
            from center_settings where center_id = v_class.center_id;

            if coalesce(v_weekly_limit, 0) = 0 then
                raise exception '이 수업은 정원이 찼고, 이 센터는 대기예약을 사용하지 않아요';
            end if;

            v_week_start := date_trunc('week', v_local_date)::date;
            select count(*) into v_week_count
            from reservations r
            join classes c on c.id = r.class_id
            where r.profile_id = v_profile_id
              and c.center_id = v_class.center_id
              and r.status = 'waitlisted'
              and (c.start_time at time zone 'Asia/Seoul')::date >= v_week_start
              and (c.start_time at time zone 'Asia/Seoul')::date < v_week_start + 7;

            if v_week_count >= v_weekly_limit then
                raise exception '이번 주 대기예약 가능 횟수(%회)를 초과했어요', v_weekly_limit;
            end if;
        end;

        v_status := 'waitlisted';
        select coalesce(max(waitlist_order), 0) + 1 into v_wait_order
        from reservations where class_id = p_class_id and status = 'waitlisted';

        insert into reservations (class_id, profile_id, membership_id, status, waitlist_order)
        values (p_class_id, v_profile_id, v_membership.id, 'waitlisted', v_wait_order)
        returning id into v_reservation_id;
    end if;

    return json_build_object('status', v_status, 'reservation_id', v_reservation_id);
end;
$$;

-- ------------------------------------------------------------
-- [6] reserve_with_membership() — 동일하게 starts_at 체크 추가
-- ------------------------------------------------------------
create or replace function reserve_with_membership(p_class_id uuid, p_profile_id uuid, p_membership_id uuid)
returns json
language plpgsql
security definer
set search_path to 'public'
as $$
declare
    v_class record;
    v_mem record;
    v_confirmed int;
    v_status text;
    v_order int;
    v_reservation_id uuid;
    v_local_date date;
    v_day_of_week int;
    v_local_time time;
begin
    if not exists (
        select 1 from profiles where id = p_profile_id and account_id = my_account_id()
    ) then
        raise exception '본인 계정의 프로필만 예약할 수 있어요';
    end if;

    select * into v_class from classes where id = p_class_id for update;
    if not found then raise exception '수업을 찾을 수 없어요'; end if;
    if v_class.status = 'cancelled' then raise exception '폐강된 수업이에요'; end if;
    if v_class.status = 'closed' then raise exception '예약이 마감된 수업이에요'; end if;

    v_local_date := (v_class.start_time at time zone 'Asia/Seoul')::date;
    v_local_time := (v_class.start_time at time zone 'Asia/Seoul')::time;
    v_day_of_week := extract(dow from (v_class.start_time at time zone 'Asia/Seoul'))::int;

    if now() >= v_class.start_time then
        raise exception '수업이 시작되었습니다.';
    end if;

    declare
        v_book_deadline timestamptz;
    begin
        if v_class.booking_deadline_min is not null then
            v_book_deadline := v_class.start_time - make_interval(mins => v_class.booking_deadline_min);
        else
            v_book_deadline := calc_deadline(v_class.center_id, v_class.class_format, v_class.start_time, 'book');
            if v_book_deadline is null then
                v_book_deadline := v_class.start_time;
            end if;
        end if;
        if now() > v_book_deadline then
            raise exception '예약 마감시간이 지났어요';
        end if;
    end;

    declare
        v_open_deadline timestamptz;
    begin
        v_open_deadline := calc_deadline(v_class.center_id, v_class.class_format, v_class.start_time, 'open');
        if v_open_deadline is not null and now() < v_open_deadline then
            raise exception '아직 예약이 열리지 않았어요';
        end if;
    end;

    if v_class.booking_deadline_min is null and v_local_date = (now() at time zone 'Asia/Seoul')::date then
        declare
            v_allow_same_day boolean;
        begin
            select allow_same_day_booking into v_allow_same_day
            from center_settings where center_id = v_class.center_id;
            if coalesce(v_allow_same_day, true) = false then
                raise exception '당일 예약은 허용되지 않아요';
            end if;
        end;
    end if;

    declare
        v_daily_enabled boolean;
        v_daily_limit   int;
        v_daily_count   int;
    begin
        select daily_book_limit_enabled, daily_book_limit
          into v_daily_enabled, v_daily_limit
        from center_settings where center_id = v_class.center_id;

        if coalesce(v_daily_enabled, false) and v_daily_limit is not null then
            select count(*) into v_daily_count
            from reservations r
            join classes c on c.id = r.class_id
            where r.profile_id = p_profile_id
              and c.center_id = v_class.center_id
              and (c.start_time at time zone 'Asia/Seoul')::date = v_local_date
              and r.status in ('confirmed', 'waitlisted');

            if v_daily_count >= v_daily_limit then
                raise exception '하루 예약 가능 횟수(%회)를 초과했어요', v_daily_limit;
            end if;
        end if;
    end;

    if exists (
        select 1 from center_holidays
        where center_id = v_class.center_id
          and holiday_date = v_local_date
    ) then
        raise exception '센터 휴무일이라 예약할 수 없어요';
    end if;

    if v_class.class_format = 'private' then
        declare
            v_pmc_enabled boolean;
            v_pmc_limit   int;
            v_concurrent  int;
        begin
            select private_max_concurrent_enabled, private_max_concurrent
              into v_pmc_enabled, v_pmc_limit
            from center_settings where center_id = v_class.center_id;

            if coalesce(v_pmc_enabled, false) and v_pmc_limit is not null then
                select count(*) into v_concurrent
                from classes c2
                join reservations r2 on r2.class_id = c2.id and r2.status = 'confirmed'
                where c2.center_id = v_class.center_id
                  and c2.class_format = 'private'
                  and c2.id <> v_class.id
                  and c2.status <> 'cancelled'
                  and c2.start_time < v_class.end_time
                  and c2.end_time > v_class.start_time;

                if v_concurrent >= v_pmc_limit then
                    raise exception '같은 시간대에 진행 가능한 프라이빗 수업이 이미 다 찼어요(최대 %건)', v_pmc_limit;
                end if;
            end if;
        end;
    end if;

    select m.* into v_mem
    from memberships m
    where m.id = p_membership_id
      and m.center_id = v_class.center_id
      and m.status = 'active'
      and (m.remaining_count is null or m.remaining_count > 0)
      and (m.expires_at is null or m.expires_at >= current_date)
      and (m.starts_at is null or m.starts_at <= current_date)
      and m.profile_id in (select id from profiles where account_id = my_account_id())
      and is_membership_eligible_for_class(m.id, v_class.id)
    for update;
    if not found then
        raise exception '사용할 수 없는 수강권이에요';
    end if;

    if exists (
        select 1 from reservations
        where class_id = p_class_id and profile_id = p_profile_id
          and status in ('confirmed', 'waitlisted', 'attended')
    ) then
        raise exception '이미 예약한 수업이에요';
    end if;

    select count(*) into v_confirmed
    from reservations
    where class_id = p_class_id and status in ('confirmed', 'attended');

    if v_confirmed >= v_class.capacity then
        if v_class.class_format = 'private' then
            raise exception '이미 다른 회원이 예약한 프라이빗 수업이에요';
        end if;

        declare
            v_weekly_limit int;
            v_week_start   date;
            v_week_count   int;
        begin
            select waitlist_weekly_limit into v_weekly_limit
            from center_settings where center_id = v_class.center_id;

            if coalesce(v_weekly_limit, 0) = 0 then
                raise exception '이 수업은 정원이 찼고, 이 센터는 대기예약을 사용하지 않아요';
            end if;

            v_week_start := date_trunc('week', v_local_date)::date;
            select count(*) into v_week_count
            from reservations r
            join classes c on c.id = r.class_id
            where r.profile_id = p_profile_id
              and c.center_id = v_class.center_id
              and r.status = 'waitlisted'
              and (c.start_time at time zone 'Asia/Seoul')::date >= v_week_start
              and (c.start_time at time zone 'Asia/Seoul')::date < v_week_start + 7;

            if v_week_count >= v_weekly_limit then
                raise exception '이번 주 대기예약 가능 횟수(%회)를 초과했어요', v_weekly_limit;
            end if;
        end;

        select coalesce(max(waitlist_order), 0) + 1 into v_order
        from reservations where class_id = p_class_id and status = 'waitlisted';
        v_status := 'waitlisted';
        insert into reservations (
            class_id, profile_id, membership_id, status, waitlist_order,
            reservation_type, reservation_source, created_by_account_id, membership_consumed
        )
        values (
            p_class_id, p_profile_id, p_membership_id, v_status, v_order,
            'MEMBER', 'USER', my_account_id(), false
        )
        returning id into v_reservation_id;
    else
        v_status := 'confirmed';
        insert into reservations (
            class_id, profile_id, membership_id, status,
            reservation_type, reservation_source, created_by_account_id, membership_consumed
        )
        values (
            p_class_id, p_profile_id, p_membership_id, v_status,
            'MEMBER', 'USER', my_account_id(), true
        )
        returning id into v_reservation_id;
        update memberships set remaining_count = remaining_count - 1
        where id = p_membership_id and remaining_count is not null;
    end if;

    return json_build_object('status', v_status, 'waitlist_order', v_order, 'reservation_id', v_reservation_id);
end;
$$;

-- ------------------------------------------------------------
-- [7] usable_memberships_for_classes() — 예약화면 "사용 가능 수강권 목록"에도
--     동일하게 starts_at 체크 추가(아직 시작 안 한 수강권은 목록에서 안 보임)
-- ------------------------------------------------------------
create or replace function usable_memberships_for_classes(p_class_ids uuid[], p_profile_id uuid)
returns table(class_id uuid, membership_id uuid, product_name text, remaining_count integer, expires_at date, owner_profile text, is_mine boolean, issued_at date)
language sql
security definer
set search_path to 'public'
as $$
    with cls as (
        select c.id, c.center_id, c.title, c.pass_selection_mode,
               (c.start_time at time zone 'Asia/Seoul')::time as ltime,
               extract(dow from (c.start_time at time zone 'Asia/Seoul'))::int as ldow
        from classes c
        where c.id = any(p_class_ids)
    )
    select
        cls.id,
        m.id,
        m.product_name,
        m.remaining_count,
        m.expires_at,
        coalesce(p.name, ''),
        (m.profile_id = p_profile_id),
        m.issued_at
    from cls
    join memberships m on m.center_id = cls.center_id
    join products pd on pd.id = m.product_id
    left join profiles p on p.id = m.profile_id
    where m.status = 'active'
      and pd.product_kind = 'pass'
      and (m.remaining_count is null or m.remaining_count > 0)
      and (m.expires_at is null or m.expires_at >= current_date)
      and (m.starts_at is null or m.starts_at <= current_date)
      and m.profile_id in (select id from profiles where account_id = my_account_id())
      and (
            cls.pass_selection_mode = 'all'
            or m.product_id in (select cap.product_id from class_allowed_products cap where cap.class_id = cls.id)
      )
      and (
            (
                cls.pass_selection_mode = 'selected'
                and exists (
                    select 1 from class_allowed_products cap
                    where cap.class_id = cls.id and cap.product_id = m.product_id
                )
            )
            or m.product_id is null
            or not exists (select 1 from membership_schedule_rules r where r.product_id = m.product_id)
            or exists (
                select 1 from membership_schedule_rules r
                where r.product_id = m.product_id
                  and (r.day_of_week is null or r.day_of_week = cls.ldow)
                  and (r.start_time is null or r.start_time = cls.ltime)
                  and (r.class_title is null or r.class_title = cls.title)
            )
      );
$$;

-- ------------------------------------------------------------
-- [8] auto_book_membership() — 요일반 자동예약 대상 수업 필터에도 starts_at 체크 추가
-- ------------------------------------------------------------
create or replace function auto_book_membership(p_membership_id uuid)
returns json
language plpgsql
security definer
set search_path to 'public'
as $$
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
$$;

-- ============================================================
-- 확인
-- ============================================================
select column_name from information_schema.columns
where table_name = 'products' and column_name in ('rolling_month_cutoff_day', 'rolling_month_allow_early_use');
select column_name from information_schema.columns
where table_name = 'memberships' and column_name = 'starts_at';
select proname from pg_proc where proname = 'calc_rolling_month_dates';
-- 컷오프=15일 때 4/20→5월, 5/10→5월, 5/15→6월이 되는지 직접 확인:
select * from calc_rolling_month_dates('2026-04-20 12:00:00+09'::timestamptz, 15);
select * from calc_rolling_month_dates('2026-05-10 12:00:00+09'::timestamptz, 15);
select * from calc_rolling_month_dates('2026-05-15 12:00:00+09'::timestamptz, 15);
