-- ============================================================
-- 주문 발급/자동예약 통합 수정 (2026-10-01 QA 배치)
--
-- 근거: 라이브 DB의 pg_get_functiondef를 기준으로 작성했다(저장소의 옛 migration 파일 기준 X —
--   add_weekday_time_fixed_memberships.sql 때 겪은 드리프트 사고 재발 방지). 기준 시점에 라이브에는
--   요일/시간 고정(bound_day_of_week / bound_start_time)과 weekday 관련 5개 함수가 이미 적용돼 있다.
--
-- [수정 1] 자동예약이 수강권 만료일(KST 날짜 기준)을 최우선으로 지킨다 + 미배치 사유 구분
--   - 예전: c.start_time::date(UTC 날짜)로 만료일을 비교 → 한국 새벽 수업이 하루 어긋날 수 있었음.
--   - 예전: 요일은 products.auto_book_days만 봤다 → "구매 시 요일 선택(weekday_selectable)" 상품은
--     auto_book_days가 null이라 항상 'not_weekday_pass'로 아무 것도 예약하지 못했다(QA 4B 원인).
--     이제 memberships.bound_day_of_week가 있으면 그 요일을 쓴다.
--   - 예전: bound_start_time/수강권 지정 수업 등 "예약 가능 조건"을 수동예약과 따로 구현했다.
--     이제 수동예약과 동일한 is_membership_eligible_for_class()를 그대로 호출한다.
--   - 반환에 reason/skipped(만료일 초과·정원·예약조건·이미 예약·예약기간) 카운트를 담는다.
-- [수정 2] 하드코딩 쿠폰 WELCOME/FIGURE10 제거(센터가 만드는 coupons/member_coupons는 그대로).
-- [수정 3] 주문 금액 검증을 한 함수(_order_expected_amount)로 통일 — fulfill_order(직접결제)와
--   _issue_membership_and_record_payment(PG)가 같은 공식을 쓴다:
--     기대금액 = 상품가 - 서버가 검증한 센터 쿠폰 할인 - 원장으로 확인한 포인트
--   예전 fulfill_order는 orders.amount(할인 후 금액)를 상품 원가와 직접 비교해
--   "주문 금액을 확인할 수 없어요. 상품 가격과 다릅니다"로 거절했다.
-- [수정 4] 직접결제 승인(fulfill_order)과 PG 확정이 같은 자동예약 헬퍼를 쓰고, 오류를 삼키지 않고
--   반환값(auto_book_requested / auto_booked_count / unplaced_count / auto_book_reason / auto_book_error)
--   으로 돌려준다. 발급 자체는 기존 정책대로 롤백하지 않는다(자동예약만 서브트랜잭션으로 격리).
-- [수정 6] 주문의 선택 사이즈를 memberships.selected_size로 복사(예전엔 유실).
--
-- [선행] add_selectable_count_pricing.sql(orders.selected_count / orders.product_amount_snapshot, 회차별 가격표).
--   기대금액의 "상품 기본금액"은 주문 생성 시점에 서버가 확정한 product_amount_snapshot(고정=상품가, 선택형=가격표에서 그 횟수의 가격)을 쓰고,
--   발급 횟수는 선택형이면 orders.selected_count, 고정이면 상품 total_count다.
--
-- 변경 대상: 컬럼 2개 추가, 함수 신규 3개, 함수 교체 5개(+ unplaced_weekday_passes는 반환 컬럼이
--   늘어 DROP 후 재생성). 기존 데이터는 건드리지 않는다. 여러 번 실행해도 안전.
-- 이 세션에서는 production에 실행하지 않았습니다.
-- ============================================================

alter table memberships add column if not exists selected_size text;
alter table memberships add column if not exists auto_book_requested boolean not null default false;

-- ------------------------------------------------------------
-- 1) 주문 기대금액 — 클라이언트가 보낸 할인/금액은 신뢰하지 않고 서버가 처음부터 다시 계산
-- ------------------------------------------------------------
create or replace function _order_expected_amount(p_order orders, p_lock boolean default false)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
    v_product           record;
    v_member_coupon     record;
    v_verified_discount int := 0;
    v_points_verified   boolean;
    v_base              int;
begin
    if p_order.product_id is null then
        return null;
    end if;
    select * into v_product from products where id = p_order.product_id;
    if not found then
        return null;
    end if;

    -- 상품 기본금액: 주문 생성 시점에 서버(orders BEFORE INSERT 트리거)가 확정한 snapshot — 이후 상품 가격이
    -- 바뀌어도 기존 주문의 검증/발급 금액이 변하지 않는다. snapshot이 없는 옛 주문만 현재 상품가로 계산한다.
    v_base := coalesce(p_order.product_amount_snapshot, v_product.price);

    if p_order.member_coupon_id is not null then
        if not coalesce(v_product.coupon_eligible, true) then
            raise exception '이 수강권은 쿠폰을 적용할 수 없어요.';
        end if;

        if p_lock then
            select mc.*, c.discount_type, c.discount_value, c.max_discount_amount,
                   c.minimum_order_amount, c.applies_to, c.valid_from, c.valid_until,
                   c.status as coupon_status, c.center_id as coupon_center_id
              into v_member_coupon
              from member_coupons mc
              join coupons c on c.id = mc.coupon_id
             where mc.id = p_order.member_coupon_id
             for update of mc;
        else
            select mc.*, c.discount_type, c.discount_value, c.max_discount_amount,
                   c.minimum_order_amount, c.applies_to, c.valid_from, c.valid_until,
                   c.status as coupon_status, c.center_id as coupon_center_id
              into v_member_coupon
              from member_coupons mc
              join coupons c on c.id = mc.coupon_id
             where mc.id = p_order.member_coupon_id;
        end if;

        if not found then
            raise exception '쿠폰을 찾을 수 없어요';
        end if;
        if not exists (
            select 1 from center_members cm
            where cm.id = v_member_coupon.center_member_id
              and cm.profile_id = p_order.profile_id
        ) then
            raise exception '본인에게 지급된 쿠폰만 사용할 수 있어요';
        end if;
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
        if v_member_coupon.minimum_order_amount is not null and v_base < v_member_coupon.minimum_order_amount then
            raise exception '최소 결제금액(%원) 미만이라 쿠폰을 사용할 수 없어요', v_member_coupon.minimum_order_amount;
        end if;

        if v_member_coupon.discount_type = 'fixed' then
            v_verified_discount := v_member_coupon.discount_value;
        else
            v_verified_discount := least(
                (v_base * v_member_coupon.discount_value) / 100,
                coalesce(v_member_coupon.max_discount_amount, v_base)
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

    return greatest(0, v_base - v_verified_discount - coalesce(p_order.points_used, 0));
end;
$$;
revoke all on function _order_expected_amount(orders, boolean) from public, anon, authenticated;

-- ------------------------------------------------------------
-- 2) 자동예약 코어 — 권한 검사 없는 내부 함수(호출부가 권한을 보장). 수동예약과 같은
--    is_membership_eligible_for_class()를 쓴다. p_dry_run=true면 아무것도 쓰지 않고 "지금 돌리면
--    어떻게 되는지"만 계산(미배치 목록의 사유 표시용).
-- ------------------------------------------------------------
create or replace function _auto_book_membership_core(p_membership_id uuid, p_dry_run boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_mem     record;
    v_days    int[];
    v_left    int;
    v_start_left int;
    v_booked  int := 0;
    v_class   record;
    v_taken   int;
    v_used_dates date[] := '{}';
    v_cdate   date;
    v_today   date := (now() at time zone 'Asia/Seoul')::date;
    v_book_deadline timestamptz;
    v_open_deadline timestamptz;
    v_daily_enabled boolean;
    v_daily_limit   int;
    v_daily_count   int;
    v_pmc_enabled boolean;
    v_pmc_limit   int;
    v_concurrent  int;
    n_outside int := 0;   -- 조건은 맞지만 수강권 사용기간(시작~만료일) 밖
    n_mismatch int := 0;  -- 요일은 맞지만 예약 조건(시간/수강권 지정/규칙) 불일치
    n_dup int := 0;       -- 그 날짜에 이미 예약이 있음(또는 하루 한도)
    n_full int := 0;      -- 정원 부족
    n_window int := 0;    -- 휴무일/예약기간/동시 프라이빗 한도
    n_ok int := 0;        -- 사용기간 안 + 조건 일치 후보(위 장애물 포함)
    v_reason text;
begin
    if p_dry_run then
        select * into v_mem from memberships where id = p_membership_id;
    else
        select * into v_mem from memberships where id = p_membership_id for update;
    end if;
    if not found then
        return jsonb_build_object('booked', 0, 'unplaced', 0, 'reason', 'membership_not_found');
    end if;
    if v_mem.status <> 'active' then
        return jsonb_build_object('booked', 0, 'unplaced', coalesce(v_mem.remaining_count, 0), 'reason', 'membership_inactive');
    end if;

    v_days := case
        when v_mem.bound_day_of_week is not null then array[v_mem.bound_day_of_week]
        else (select auto_book_days from products where id = v_mem.product_id)
    end;
    if v_days is null or array_length(v_days, 1) is null then
        return jsonb_build_object('booked', 0, 'unplaced', coalesce(v_mem.remaining_count, 0), 'reason', 'not_weekday_pass');
    end if;

    v_left := coalesce(v_mem.remaining_count, 0);
    v_start_left := v_left;
    if v_left <= 0 then
        return jsonb_build_object('booked', 0, 'unplaced', 0, 'reason', 'no_remaining');
    end if;

    -- 이미 만료일이 지난 수강권은 어떤 수업도 배치할 수 없다(만료일 우선).
    if v_mem.expires_at is not null and v_mem.expires_at < v_today then
        return jsonb_build_object('booked', 0, 'unplaced', v_left, 'reason', 'outside_membership_period',
                                  'skipped', jsonb_build_object('outside_period', 0));
    end if;

    select daily_book_limit_enabled, daily_book_limit,
           private_max_concurrent_enabled, private_max_concurrent
      into v_daily_enabled, v_daily_limit, v_pmc_enabled, v_pmc_limit
    from center_settings where center_id = v_mem.center_id;

    for v_class in
        select c.id, c.capacity, c.start_time, c.end_time, c.class_format,
               c.booking_deadline_min, c.center_id,
               (c.start_time at time zone 'Asia/Seoul')::date as class_date
        from classes c
        where c.center_id = v_mem.center_id
          and c.status = 'open'
          and c.start_time > now()
          and extract(dow from (c.start_time at time zone 'Asia/Seoul'))::int = any(v_days)
        order by c.start_time asc
    loop
        exit when v_left <= 0;
        v_cdate := v_class.class_date;

        -- 수동예약과 동일한 자격 판정(수강권 지정/예약조건 규칙/bound 요일·시간)
        if not is_membership_eligible_for_class(v_mem.id, v_class.id) then
            n_mismatch := n_mismatch + 1;
            continue;
        end if;

        -- 수강권 사용기간이 최우선: 만료일/시작일 밖의 수업은 횟수가 남아 있어도 절대 예약하지 않는다.
        if (v_mem.expires_at is not null and v_cdate > v_mem.expires_at)
           or (v_mem.starts_at is not null and v_cdate < v_mem.starts_at) then
            n_outside := n_outside + 1;
            continue;
        end if;
        n_ok := n_ok + 1;

        if exists (
            select 1 from center_holidays ch
            where ch.center_id = v_class.center_id and ch.holiday_date = v_cdate
        ) then
            n_window := n_window + 1;
            continue;
        end if;

        if v_cdate = any(v_used_dates) then
            n_dup := n_dup + 1;
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
            n_dup := n_dup + 1;
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
            n_window := n_window + 1;
            continue;
        end if;

        v_open_deadline := calc_deadline(v_class.center_id, v_class.class_format, v_class.start_time, 'open');
        if v_open_deadline is not null and now() < v_open_deadline then
            n_window := n_window + 1;
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
                n_window := n_window + 1;
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
                n_dup := n_dup + 1;
                continue;
            end if;
        end if;

        select count(*) into v_taken
        from reservations
        where class_id = v_class.id and status in ('confirmed', 'attended');
        if v_taken >= v_class.capacity then
            n_full := n_full + 1;
            continue;
        end if;

        if not p_dry_run then
            insert into reservations (class_id, profile_id, membership_id, status)
            values (v_class.id, v_mem.profile_id, v_mem.id, 'confirmed');
        end if;
        v_used_dates := array_append(v_used_dates, v_cdate);
        v_left := v_left - 1;
        v_booked := v_booked + 1;
    end loop;

    if v_booked > 0 and not p_dry_run then
        update memberships
           set remaining_count = remaining_count - v_booked
         where id = p_membership_id
           and remaining_count is not null;
    end if;

    -- 못 채운 횟수가 있으면 주된 사유 하나를 고른다.
    --   outside_membership_period: 만료일 안에 둘 수 있는 후보는 다 찼고, 남은 건 만료일 이후 수업뿐
    if v_left <= 0 then
        v_reason := 'ok';
    elsif n_ok = 0 and n_outside > 0 then
        v_reason := 'outside_membership_period';
    elsif n_full > 0 then
        v_reason := 'capacity_full';
    elsif n_dup > 0 then
        v_reason := 'already_reserved';
    elsif n_window > 0 then
        v_reason := 'booking_window';
    elsif n_ok = 0 and n_mismatch > 0 then
        v_reason := 'condition_mismatch';
    elsif n_outside > 0 then
        v_reason := 'outside_membership_period';
    else
        v_reason := 'no_class_in_period';
    end if;

    return jsonb_build_object(
        'booked', v_booked,
        'unplaced', v_left,
        'reason', v_reason,
        'skipped', jsonb_build_object(
            'outside_period', n_outside, 'condition_mismatch', n_mismatch,
            'already_reserved', n_dup, 'capacity_full', n_full, 'booking_window', n_window)
    );
end;
$$;
revoke all on function _auto_book_membership_core(uuid, boolean) from public, anon, authenticated;

-- ------------------------------------------------------------
-- 3) 발급 직후 자동예약 헬퍼 — 오류를 삼키지 않고 결과로 돌려준다(발급은 롤백하지 않음).
-- ------------------------------------------------------------
create or replace function _order_auto_book(p_membership_id uuid, p_requested boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_res jsonb;
begin
    if not coalesce(p_requested, false) then
        return jsonb_build_object('auto_book_requested', false, 'auto_booked_count', 0,
                                  'unplaced_count', 0, 'auto_book_reason', 'not_requested');
    end if;
    begin
        v_res := _auto_book_membership_core(p_membership_id, false);
    exception when others then
        -- 서브트랜잭션이라 코어가 일부 예약을 만들었어도 모두 되돌려진다(부분 차감 없음).
        return jsonb_build_object('auto_book_requested', true, 'auto_booked_count', 0,
                                  'unplaced_count', null, 'auto_book_reason', 'error',
                                  'auto_book_error', sqlstate || ': ' || sqlerrm);
    end;
    return jsonb_build_object('auto_book_requested', true,
                              'auto_booked_count', coalesce((v_res->>'booked')::int, 0),
                              'unplaced_count', coalesce((v_res->>'unplaced')::int, 0),
                              'auto_book_reason', v_res->>'reason');
end;
$$;
revoke all on function _order_auto_book(uuid, boolean) from public, anon, authenticated;

-- ------------------------------------------------------------
-- 4) auto_book_membership — 권한 검사(라이브 그대로) + 코어
-- ------------------------------------------------------------
create or replace function public.auto_book_membership(p_membership_id uuid)
returns json
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
    v_center_id uuid;
begin
    select center_id into v_center_id from memberships where id = p_membership_id;
    if v_center_id is null then
        raise exception '수강권을 찾을 수 없어요';
    end if;
    if not (v_center_id in (select my_managed_center_ids()) or is_platform_admin()) then
        raise exception '이 수강권을 자동예약 처리할 권한이 없어요';
    end if;
    return _auto_book_membership_core(p_membership_id, false)::json;
end;
$function$;

-- ------------------------------------------------------------
-- 5) 미배치 목록 — 사유/만료 여부 포함(반환 컬럼이 늘어 DROP 후 재생성)
-- ------------------------------------------------------------
drop function if exists unplaced_weekday_passes(uuid);
create function public.unplaced_weekday_passes(p_center_id uuid)
returns table(
    membership_id uuid, profile_id uuid, member_name text, product_name text,
    total_count integer, remaining_count integer, auto_book_days integer[],
    expires_at date, purchased_at timestamptz,
    bound_day_of_week integer, bound_start_time time,
    expired boolean, can_retry boolean, reason_code text, placeable_count integer, skipped jsonb
)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
    v_row record;
    v_res jsonb;
    v_today date := (now() at time zone 'Asia/Seoul')::date;
begin
    if not (p_center_id in (select my_managed_center_ids()) or is_platform_admin()) then
        return;
    end if;
    for v_row in
        select m.id as mid, m.profile_id as pid, coalesce(p.name, '(이름 없음)') as pname,
               m.product_name as prod, m.total_count as tc, m.remaining_count as rc,
               pr.auto_book_days as abd, m.expires_at as exp, m.created_at as cat,
               m.bound_day_of_week as bdow, m.bound_start_time as bst
        from memberships m
        join products pr on pr.id = m.product_id
        left join profiles p on p.id = m.profile_id
        where m.center_id = p_center_id
          and m.status = 'active'
          and ((pr.auto_book_days is not null and array_length(pr.auto_book_days, 1) > 0) or m.auto_book_requested)
          and coalesce(m.remaining_count, 0) > 0
        order by m.created_at asc
    loop
        v_res := _auto_book_membership_core(v_row.mid, true);
        membership_id := v_row.mid; profile_id := v_row.pid; member_name := v_row.pname;
        product_name := v_row.prod; total_count := v_row.tc; remaining_count := v_row.rc;
        auto_book_days := v_row.abd; expires_at := v_row.exp; purchased_at := v_row.cat;
        bound_day_of_week := v_row.bdow; bound_start_time := v_row.bst;
        expired := v_row.exp is not null and v_row.exp < v_today;
        can_retry := not expired;
        reason_code := coalesce(v_res->>'reason', 'unknown');
        placeable_count := coalesce((v_res->>'booked')::int, 0);
        skipped := coalesce(v_res->'skipped', '{}'::jsonb);
        return next;
    end loop;
end;
$function$;
revoke all on function unplaced_weekday_passes(uuid) from public, anon;
grant execute on function unplaced_weekday_passes(uuid) to authenticated, service_role;

-- ------------------------------------------------------------
-- 6) fulfill_order(직접결제/관리자 확정·발급)
-- ------------------------------------------------------------
create or replace function public.fulfill_order(p_order_id uuid)
returns json
language plpgsql
security definer
set search_path to 'public'
as $function$
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

-- ------------------------------------------------------------
-- 7) _issue_membership_and_record_payment(PG 확정) — 라이브 로직 유지 + 공통 검증/자동예약
-- ------------------------------------------------------------
create or replace function public._issue_membership_and_record_payment(p_order orders, p_provider_ref text, p_memo text)
returns json
language plpgsql
security definer
as $function$
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
    v_starts := current_date;
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
                    when 'days' then (now() + (coalesce(v_product.expiry_days, 0) || ' days')::interval)::date
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

-- ------------------------------------------------------------
-- 8) confirm_real_payment / confirm_test_payment — 자동예약 결과를 그대로 전달(나머지 라이브 로직 유지)
-- ------------------------------------------------------------
create or replace function public.confirm_real_payment(p_order_id uuid, p_payment_key text, p_amount integer)
returns json
language plpgsql
security definer
as $function$
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

    return (jsonb_build_object('already_done', false) || v_result::jsonb)::json;
end;
$function$;

create or replace function public.confirm_test_payment(p_order_id uuid, p_provider_ref text)
returns json
language plpgsql
security definer
as $function$
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

-- ============================================================
-- 확인(읽기 전용)
-- ============================================================
select proname, prosecdef
from pg_proc
where pronamespace = 'public'::regnamespace
  and proname in ('_order_expected_amount', '_auto_book_membership_core', '_order_auto_book',
                  'auto_book_membership', 'unplaced_weekday_passes', 'fulfill_order',
                  '_issue_membership_and_record_payment', 'confirm_real_payment', 'confirm_test_payment')
order by 1;
-- 하드코딩 쿠폰 문자열이 함수 본문에 남아있지 않아야 한다(0건)
select count(*) as hardcoded_coupon_refs
from pg_proc
where pronamespace = 'public'::regnamespace and (prosrc ilike '%WELCOME%' or prosrc ilike '%FIGURE10%');
