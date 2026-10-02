-- fix_grant_schedule_and_kst_dates_20261003.sql 직전의 Production 라이브 정의로 복원한다(2026-10-03 읽기 전용 pg_get_functiondef 기준) + helper 함수 제거.
-- 주의: 복원하면 F6(규칙에 없는 bound 요일 지급)과 KST 날짜 어긋남이 다시 생긴다.
begin;

CREATE OR REPLACE FUNCTION public.manager_grant_product(p_center_id uuid, p_profile_id uuid, p_product_id uuid, p_price integer, p_pay_method text, p_memo text DEFAULT NULL::text, p_paid_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_trainer_account_id uuid DEFAULT NULL::uuid, p_bound_day_of_week integer DEFAULT NULL::integer, p_bound_start_time time without time zone DEFAULT NULL::time without time zone, p_selected_size text DEFAULT NULL::text, p_selected_count integer DEFAULT NULL::integer)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_product     products;
    v_is_goods    boolean;
    v_unlimited   boolean;
    v_count       int;
    v_expires     date;
    v_starts      date := current_date;
    v_rm          record;
    v_size        text;
    v_bound_dow   int;
    v_bound_time  time;
    v_sold        int;
    v_granter     text;
    v_memo        text;
    v_membership_id uuid;
    v_payment_id    uuid;
    v_granted_count int;
begin
    if not (
        (has_permission(p_center_id, 'customer.member.issue_pass') and has_permission(p_center_id, 'pass.payment.create'))
        or is_platform_admin()
    ) then
        raise exception '수강권/상품을 지급할 권한이 없어요';
    end if;

    if p_price is null or p_price < 0 then
        raise exception '가격을 올바르게 입력해주세요';
    end if;
    if p_pay_method not in ('card', 'cash', 'transfer', 'service') then
        raise exception '결제방법이 올바르지 않아요';
    end if;
    if p_price = 0 and p_pay_method <> 'service' then
        raise exception '가격이 0원이면 결제방법은 서비스(무상 지급)여야 해요';
    end if;
    if p_price > 0 and p_pay_method = 'service' then
        raise exception '가격이 있으면 서비스로는 지급할 수 없어요 — 결제방법을 골라주세요';
    end if;

    -- 같은 센터 회원에게만 지급(다른 센터 회원 불가)
    if not exists (
        select 1 from center_members cm
        where cm.center_id = p_center_id and cm.profile_id = p_profile_id
    ) then
        raise exception '이 센터의 회원이 아니에요';
    end if;

    -- 같은 센터 상품만. 행을 잠가 동시 지급의 판매수량 확인을 직렬화한다.
    select * into v_product from products
     where id = p_product_id and center_id = p_center_id
     for update;
    if not found then
        raise exception '이 센터의 상품이 아니에요';
    end if;
    if not coalesce(v_product.is_active, false) then
        raise exception '삭제되었거나 비활성화된 상품이에요';
    end if;
    -- 관리자 직접 지급은 판매중지(is_on_sale=false) 상품도 허용한다(보상/서비스 목적).

    v_is_goods := v_product.product_kind = 'goods';

    -- 사이즈: 상품에 sizes가 정의돼 있으면 필수 + 목록 안의 값만
    if v_product.sizes is not null and coalesce(array_length(v_product.sizes, 1), 0) > 0 then
        v_size := nullif(btrim(coalesce(p_selected_size, '')), '');
        if v_size is null then
            raise exception '사이즈를 선택해주세요';
        end if;
        if not (v_size = any(v_product.sizes)) then
            raise exception '선택할 수 없는 사이즈예요';
        end if;
    else
        v_size := null;
    end if;

    -- 요일/시간 선택형 수강권(goods에는 해당 없음)
    if not v_is_goods and coalesce(v_product.weekday_selectable, false) then
        if p_bound_day_of_week is null or p_bound_day_of_week < 0 or p_bound_day_of_week > 6 then
            raise exception '이용 요일을 선택해주세요';
        end if;
        v_bound_dow := p_bound_day_of_week;
        if coalesce(v_product.time_selectable, false) then
            if p_bound_start_time is null then
                raise exception '이용 시간을 선택해주세요';
            end if;
            v_bound_time := p_bound_start_time;
        end if;
    end if;

    -- 판매수량 제한(trg_enforce_product_sale_limit와 같은 기준 — 여기선 더 명확한 메시지)
    if v_product.max_quantity is not null then
        select count(*) into v_sold from memberships
         where product_id = v_product.id and status <> 'refunded';
        if v_sold >= v_product.max_quantity then
            raise exception '지급 가능한 수량이 없어요(판매 수량이 모두 소진됐어요)';
        end if;
    end if;

    -- 횟수/만료는 상품 정의 그대로. 구매 횟수 선택형 상품은 관리자가 고른 횟수(범위 안)를 지급한다.
    v_unlimited := case when v_is_goods then coalesce(v_product.unlimited, false) else coalesce(v_product.unlimited_pass, false) end;
    if coalesce(v_product.purchase_count_selectable, false) then
        if p_selected_count is null then
            raise exception '지급할 횟수를 선택해주세요';
        end if;
        -- 가격표에 등록된 회차만 지급 가능(구매와 같은 기준). 지급 금액은 관리자가 정하므로 여기서 가격은 강제하지 않는다.
        if not exists (select 1 from product_count_prices where product_id = v_product.id and count = p_selected_count) then
            raise exception '이 상품에서 지급할 수 없는 횟수예요(%회)', p_selected_count;
        end if;
        v_count := p_selected_count;
    else
        if p_selected_count is not null then
            raise exception '이 상품은 지급 횟수를 고를 수 없어요(상품 정의의 횟수로 지급돼요)';
        end if;
        v_count := case when v_unlimited then null else v_product.total_count end;
    end if;
    v_granted_count := v_count;
    if v_product.expiry_mode = 'rolling_month' then
        select * into v_rm from calc_rolling_month_dates(now(), v_product.rolling_month_cutoff_day);
        v_expires := v_rm.expires_at;
        if not coalesce(v_product.rolling_month_allow_early_use, false) then
            v_starts := v_rm.starts_at;
        end if;
    elsif v_product.expiry_mode = 'date' then
        v_expires := v_product.expiry_date;
    elsif v_product.expiry_mode = 'days' then
        v_expires := (now() + (coalesce(v_product.expiry_days, 0) || ' days')::interval)::date;
    else
        v_expires := null;
    end if;

    insert into memberships (
        profile_id, center_id, product_id, product_name,
        pass_type, total_count, remaining_count, expires_at, starts_at, status,
        bound_day_of_week, bound_start_time, selected_size
    ) values (
        p_profile_id, p_center_id, v_product.id, v_product.name,
        'count', v_count, v_count, v_expires, v_starts, 'active',
        v_bound_dow, v_bound_time, v_size
    ) returning id into v_membership_id;

    select name into v_granter from accounts where id = my_account_id();
    v_memo := '[관리자 지급' || coalesce(' · ' || v_granter, '') || ']'
              || coalesce(' ' || nullif(btrim(coalesce(p_memo, '')), ''), '');

    insert into payments (
        center_id, profile_id, membership_id,
        sale_type, revenue_category,
        card_amount, cash_amount, transfer_amount, point_amount,
        total_amount, unpaid_amount, trainer_account_id, paid_at, memo, status
    ) values (
        p_center_id, p_profile_id, v_membership_id,
        case when p_pay_method = 'service' then 'service' else 'new' end,
        case when v_is_goods then 'etc' else 'membership' end,
        case when p_pay_method = 'card' then p_price else 0 end,
        case when p_pay_method = 'cash' then p_price else 0 end,
        case when p_pay_method = 'transfer' then p_price else 0 end,
        0,
        p_price, 0, p_trainer_account_id, coalesce(p_paid_at, now()), v_memo, 'paid'
    ) returning id into v_payment_id;

    return json_build_object(
        'membership_id', v_membership_id,
        'payment_id', v_payment_id,
        'product_kind', v_product.product_kind,
        'selected_size', v_size,
        'granted_count', v_granted_count
    );
end;
$function$;

CREATE OR REPLACE FUNCTION public.cancel_reservation(p_reservation_id uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
    v_res         record;
    v_class       record;
    v_next        record;
    v_next_mem    record;
    v_promoted    boolean := false;
    v_skip_refund boolean := false;
    v_can_promote boolean := true;
begin
    select * into v_res from reservations
    where id = p_reservation_id
      and profile_id in (select id from profiles where account_id = my_account_id())
    for update;

    if not found then
        raise exception '예약을 찾을 수 없어요';
    end if;
    if v_res.status = 'cancelled' then
        raise exception '이미 취소된 예약이에요';
    end if;

    select * into v_class from classes where id = v_res.class_id;
    if found then
        if now() >= v_class.start_time then
            raise exception '수업이 이미 시작되어 취소할 수 없어요';
        end if;

        declare
            v_cancel_deadline    timestamptz;
            v_deduct_late        boolean := false;
            v_is_late            boolean := false;
            v_grace_deadline     timestamptz;
            v_same_day_deadline  timestamptz;
            v_effective_deadline timestamptz;
            v_settings           record;
        begin
            if v_class.cancel_deadline_min is not null then
                v_cancel_deadline := v_class.start_time - make_interval(mins => v_class.cancel_deadline_min);
            else
                v_cancel_deadline := calc_deadline(v_class.center_id, v_class.class_format, v_class.start_time, 'cancel');
                if v_cancel_deadline is null then
                    v_cancel_deadline := v_class.start_time;
                end if;
            end if;

            v_grace_deadline := least(v_res.created_at + interval '10 minutes', v_class.start_time);

            -- 취소 완전 불가(allow_cancel=false) 수업이어도 예약 직후 10분 유예(오조작
            -- 방지 안전장치, v_grace_deadline)는 그대로 유지한다 — 그 유예시간을 지난
            -- 뒤에만 완전히 차단한다(사용자 요청, 2026-09-13: "10분 이내엔 취소 가능한
            -- 건 유지해줘"). 유예시간 안이면 아래 마감시간 로직과 무관하게 항상 취소 가능.
            if v_class.allow_cancel is false and now() > v_grace_deadline then
                raise exception '이 수업은 예약 취소가 불가능해요';
            end if;

            select * into v_settings from center_settings where center_id = v_class.center_id;

            -- [1] 당일예약 안전장치 — 예약이 수업과 같은 KST 날짜에 만들어졌고(원래 조건,
            -- 유지) *동시에* 정상 계산된 마감의 날짜(KST)가 오늘보다 이전인 경우(=
            -- days_before 계산이 진짜로 "어제 이전"을 만든 문제 상황)에만 "시작 -
            -- N시간M분"을 마감 후보로 추가한다.
            --
            -- ⚠ 2026-09-10 재발 방지: 처음 이 조건을 "마감 날짜 < 오늘"만으로 좁혔다가
            -- (fix_same_day_cancel_deadline_regression.sql 최초 버전), classes.cancel_
            -- deadline_min(개별 수업 취소마감 재지정, fix_class_cancel_deadline_override.sql)
            -- 처럼 당일예약과 무관하게 "의도적으로 과거로 계산된 마감"까지 이 안전장치를
            -- 잘못 발동시켜 정상 마감 판정을 덮어써버리는 회귀를 새로 만들었다(통합테스트
            -- class-cancel-deadline-override.test.ts가 검출). "같은 날 예약" 조건을 다시
            -- 추가해 두 조건을 모두 만족할 때만 발동하도록 좁힌다 — 오늘 날짜로 정상
            -- 계산된 마감(예: groupCancelDaysBefore=0 + 특정 시각)이나, 당일예약이 아닌
            -- 개별 마감 재지정은 그대로 손대지 않는다.
            if v_settings.center_id is not null
               and (v_res.created_at at time zone 'Asia/Seoul')::date = (v_class.start_time at time zone 'Asia/Seoul')::date
               and (v_cancel_deadline at time zone 'Asia/Seoul')::date < (now() at time zone 'Asia/Seoul')::date
            then
                v_same_day_deadline := v_class.start_time
                    - make_interval(hours => coalesce(v_settings.same_day_change_hours, 0),
                                     mins  => coalesce(v_settings.same_day_change_minutes, 0));
                v_effective_deadline := greatest(v_cancel_deadline, v_grace_deadline, v_same_day_deadline);
            else
                v_effective_deadline := greatest(v_cancel_deadline, v_grace_deadline);
            end if;

            v_is_late := now() > v_effective_deadline;

            v_deduct_late := coalesce(v_settings.deduct_on_late_cancel, false);

            if v_is_late and not v_deduct_late then
                raise exception '취소 마감시간이 지났어요';
            end if;
            v_skip_refund := v_is_late and v_deduct_late;

            -- [2] 대기 자동승격 마감 — 0/0(기본값)이면 조건 없이 항상 승격(기존 동작 유지).
            if coalesce(v_settings.waitlist_auto_hours, 0) = 0 and coalesce(v_settings.waitlist_auto_minutes, 0) = 0 then
                v_can_promote := true;
            else
                v_can_promote := now() < v_class.start_time
                    - make_interval(hours => v_settings.waitlist_auto_hours, mins => v_settings.waitlist_auto_minutes);
            end if;
        end;
    end if;

    update reservations set status = 'cancelled', cancel_source = 'MEMBER' where id = p_reservation_id;

    if v_res.status = 'confirmed' then
        -- [유령 잔여횟수 방지] 환불/양도된 수강권은 되돌려받을 대상이 아니므로 건너뜀
        if not v_skip_refund then
            update memberships set remaining_count = remaining_count + 1
            where id = v_res.membership_id
              and status not in ('refunded', 'transferred');
        end if;

        if v_can_promote then
            for v_next in
                select * from reservations
                where class_id = v_res.class_id and status = 'waitlisted'
                order by waitlist_order asc
                for update
            loop
                select * into v_next_mem from memberships
                where id = v_next.membership_id
                  and remaining_count > 0
                  and expires_at >= current_date
                for update;

                if found then
                    update reservations
                    set status = 'confirmed', waitlist_order = null
                    where id = v_next.id;

                    update memberships set remaining_count = remaining_count - 1
                    where id = v_next_mem.id;

                    v_promoted := true;
                    exit;
                end if;
            end loop;
        end if;
    end if;

    return json_build_object('cancelled', true, 'waitlist_promoted', v_promoted, 'deducted', v_skip_refund);
end;
$function$;

CREATE OR REPLACE FUNCTION public.update_class_safe(p_class_id uuid, p_title text, p_description text, p_start_time timestamp with time zone, p_end_time timestamp with time zone, p_capacity integer, p_allow_goods boolean, p_room_id uuid, p_cancel_deadline_min integer, p_booking_deadline_min integer, p_class_format text, p_pass_selection_mode text, p_allow_cancel boolean DEFAULT true)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_center_id uuid;
    v_format text;
    v_orig_start timestamptz;
    v_is_own boolean;
    v_key text;
    v_verb text;
    v_old_capacity int;
    v_confirmed_count int;
    v_promoted_count int := 0;
    v_next record;
    v_next_mem record;
begin
    -- 정원 축소/확대 invariant를 안전하게 검사하려면 이 수업 행을 잠가서, 같은 순간의
    -- 다른 예약/취소/정원변경과 경쟁하지 않게 해야 한다(요청 5번 동시성 안전성).
    select center_id, class_format, start_time, capacity
      into v_center_id, v_format, v_orig_start, v_old_capacity
      from classes where id = p_class_id for update;
    if v_center_id is null then
        raise exception '수업을 찾을 수 없어요';
    end if;

    -- ⚠ 아래 own/other + past_update 권한 판정은 add_class_cancel_lock.sql(2026-09-13,
    -- 실제 최신본)에서 그대로 가져온 것 — 정원 invariant 추가와 무관하게 손대지 않는다.
    v_is_own := not exists (select 1 from class_trainers where class_id = p_class_id)
             or exists (select 1 from class_trainers where class_id = p_class_id and account_id = my_account_id());
    v_verb := case when v_orig_start < now() then 'past_update' else 'update' end;
    v_key := 'schedule.' || (case when v_is_own then 'own' else 'other' end) || '.' ||
             (case when v_format = 'private' then 'private' else 'group' end) || '.' || v_verb;
    if not (has_permission(v_center_id, v_key) or is_platform_admin()) then
        raise exception '이 수업을 수정할 권한이 없어요';
    end if;

    -- [FIX] 정원 축소 invariant(요청 2번) — 확정 인원보다 작게는 못 줄인다. 기존
    -- 예약을 자동 취소하지 않고, silent over-capacity 상태를 만들지 않도록 UPDATE
    -- 자체를 거부한다.
    if p_capacity is not null and p_capacity < v_old_capacity then
        select count(*) into v_confirmed_count
        from reservations where class_id = p_class_id and status = 'confirmed';
        if p_capacity < v_confirmed_count then
            raise exception '현재 확정 예약 인원(%명)보다 적게 정원을 줄일 수 없습니다.', v_confirmed_count;
        end if;
    end if;

    update classes set
        title = p_title,
        description = p_description,
        start_time = p_start_time,
        end_time = p_end_time,
        capacity = p_capacity,
        allow_goods = coalesce(p_allow_goods, true),
        room_id = p_room_id,
        cancel_deadline_min = coalesce(p_cancel_deadline_min, 0),
        booking_deadline_min = p_booking_deadline_min,
        class_format = coalesce(p_class_format, 'group'),
        pass_selection_mode = coalesce(p_pass_selection_mode, 'all'),
        allow_cancel = coalesce(p_allow_cancel, true)
    where id = p_class_id;

    -- [FIX] 정원 확대 시 대기자 자동 승격(요청 3번) — cancel_reservation()의 승격
    -- 루프와 동일한 규칙(순번 순, 수강권 유효성 확인, for update 잠금, 무효 후보는
    -- 건너뜀).
    if p_capacity is not null and p_capacity > v_old_capacity then
        select count(*) into v_confirmed_count
        from reservations where class_id = p_class_id and status = 'confirmed';

        for v_next in
            select * from reservations
            where class_id = p_class_id and status = 'waitlisted'
            order by waitlist_order asc
            for update
        loop
            exit when v_confirmed_count >= p_capacity;

            select * into v_next_mem from memberships
            where id = v_next.membership_id
              and remaining_count > 0
              and expires_at >= current_date
            for update;

            if found then
                update reservations
                set status = 'confirmed', waitlist_order = null
                where id = v_next.id;

                update memberships set remaining_count = remaining_count - 1
                where id = v_next_mem.id;

                v_confirmed_count := v_confirmed_count + 1;
                v_promoted_count := v_promoted_count + 1;
            end if;
        end loop;
    end if;

    return json_build_object('promoted_count', v_promoted_count);
end;
$function$;

CREATE OR REPLACE FUNCTION public.reserve_with_goods(p_class_id uuid, p_profile_id uuid DEFAULT NULL::uuid, p_membership_id uuid DEFAULT NULL::uuid, p_goods_membership_id uuid DEFAULT NULL::uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_profile_id  uuid;
    v_class       classes;
    v_goods       memberships;
    v_goods_prod  products;
    v_profile     profiles;
    v_result      json;
    v_res_id      uuid;
    v_res_status  text;
    v_size        text;
    v_size_source text := 'none';
    v_unlimited   boolean := false;
    v_usage_state text;
begin
    if p_profile_id is not null then
        select id into v_profile_id from profiles
         where id = p_profile_id and account_id = my_account_id();
    else
        select id into v_profile_id from profiles
         where account_id = my_account_id() and is_primary = true limit 1;
    end if;
    if v_profile_id is null then
        raise exception '본인 계정의 프로필만 예약할 수 있어요';
    end if;

    -- 상품을 쓰는 경우, 예약을 만들기 전에 먼저 검증하고 잠근다(실패하면 아무 것도 차감되지 않음).
    if p_goods_membership_id is not null then
        select * into v_class from classes where id = p_class_id;
        if not found then raise exception '수업을 찾을 수 없어요'; end if;
        if not coalesce(v_class.allow_goods, false) then
            raise exception '이 수업은 대여상품을 사용할 수 없어요';
        end if;

        select * into v_goods from memberships
         where id = p_goods_membership_id
         for update;
        if not found
           or v_goods.profile_id <> v_profile_id
           or v_goods.center_id <> v_class.center_id
           or v_goods.status <> 'active'
           or (v_goods.expires_at is not null and v_goods.expires_at < current_date)
           or (v_goods.starts_at is not null and v_goods.starts_at > current_date) then
            raise exception '사용할 수 없는 상품이에요';
        end if;
        select * into v_goods_prod from products where id = v_goods.product_id;
        if not found or v_goods_prod.product_kind <> 'goods' then
            raise exception '대여상품만 선택할 수 있어요';
        end if;
        v_unlimited := coalesce(v_goods_prod.unlimited, false);
        if not v_unlimited and coalesce(v_goods.remaining_count, 0) <= 0 then
            raise exception '남은 횟수가 없는 상품이에요';
        end if;

        -- 사이즈 출처: 보유 상품(구매 시 선택) → 프로필 신발 사이즈 → 없음
        if nullif(trim(coalesce(v_goods.selected_size, '')), '') is not null then
            v_size := trim(v_goods.selected_size); v_size_source := 'membership';
        else
            select * into v_profile from profiles where id = v_profile_id;
            if nullif(trim(coalesce(v_profile.shoe_size, '')), '') is not null then
                v_size := trim(v_profile.shoe_size); v_size_source := 'profile';
            end if;
        end if;
    end if;

    -- 기존 예약 함수에 그대로 위임(정원/마감/대기/수강권 검증은 한 글자도 바꾸지 않음)
    if p_membership_id is null then
        v_result := reserve_class(p_class_id, v_profile_id);
    else
        v_result := reserve_with_membership(p_class_id, v_profile_id, p_membership_id);
    end if;

    if p_goods_membership_id is null then
        return v_result;
    end if;

    v_res_id := (v_result->>'reservation_id')::uuid;
    v_res_status := v_result->>'status';

    if v_res_status = 'confirmed' then
        if not v_unlimited then
            update memberships set remaining_count = remaining_count - 1
             where id = p_goods_membership_id and remaining_count is not null;
        end if;
        v_usage_state := 'deducted';
    else
        v_usage_state := 'pending';   -- 대기예약: 승격 시점에 차감
    end if;

    insert into reservation_goods_usages (
        reservation_id, goods_membership_id, center_id, profile_id,
        product_name_snapshot, size_snapshot, size_source, unlimited,
        status, deducted_at
    ) values (
        v_res_id, p_goods_membership_id, v_goods.center_id, v_profile_id,
        v_goods.product_name, v_size, v_size_source, v_unlimited,
        v_usage_state, case when v_usage_state = 'deducted' then now() else null end
    );

    return (v_result::jsonb || jsonb_build_object('goods_status', v_usage_state))::json;
end;
$function$;

drop function if exists public.validate_product_schedule_selection(uuid, integer, time without time zone);

commit;
