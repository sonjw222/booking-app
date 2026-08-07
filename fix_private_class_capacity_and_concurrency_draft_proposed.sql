-- ============================================================
-- P2: 프라이빗(1:1) 수업 — 정원/중복예약/동시진행 제한이 실제로 지켜지지 않던 문제 수정
--
-- 코드 감사로 확인한 세 가지 실제 버그:
--
-- 1) [중복예약] reserve_class()/reserve_with_membership()는 정원이 찬 수업을 만나면
--    무조건 "대기예약(waitlist)" 경로로 빠진다. 프라이빗(capacity=1) 수업도 예외가
--    아니어서, waitlist_weekly_limit이 켜져 있으면 이미 1명이 확정된 1:1 수업에 다른
--    회원이 "대기 등록"으로 들어갈 수 있었다 — 1:1 수업에 대기 순번이라는 개념 자체가
--    말이 안 됨(관리자 화면의 "정원 1명" 안내와도 모순). 프라이빗 수업이 차 있으면
--    대기 없이 바로 거부하도록 수정.
--
-- 2) [관리자 직접배치 정원 초과] admin_assign_reservation()은 정원이 찬 수업에 대해
--    p_force_capacity=true로 다시 호출하면(관리자 화면의 "정원 초과 배치" 확인 흐름)
--    그룹 수업이든 프라이빗 수업이든 가리지 않고 그대로 확정 예약을 만든다 — 그룹
--    수업엔 의도된 기능(정원 외 추가 인원)이지만, 프라이빗(1:1) 수업에 이 경로로
--    두 번째 회원을 배치하면 "1:1"이 깨진다. 프라이빗 수업은 이 강제 배치 옵션 자체를
--    막는다(무조건 거부, override 불가).
--
-- 3) [동시 진행 제한 미작동] center_settings.private_max_concurrent_enabled/
--    private_max_concurrent(스키마·관리자 설정 화면 "프라이빗 동시 수업 최대 개수"에는
--    이미 있음)를 실제로 확인하는 코드가 예약 경로 어디에도 없었다 — 관리자가 이
--    설정을 켜고 값을 저장해도 아무 효과가 없는 "죽은 설정"이었다. 같은 센터·같은
--    시간대(겹치는 start_time~end_time)에 이미 확정된 프라이빗 수업 수를 세어, 그
--    한도에 도달하면 회원 셀프예약/관리자 직접배치 모두 거부하도록 추가.
--
-- 변경 대상: reserve_class(), reserve_with_membership(), admin_assign_reservation().
-- 세 함수 다 CREATE OR REPLACE로 이 부분만 추가하고 나머지 로직(예약마감/오픈/일일한도/
-- 휴무일/수강권 매칭 등, P0-2에서 이미 검증된 부분)은 전혀 바꾸지 않는다.
-- ============================================================

create or replace function reserve_class(p_class_id uuid, p_profile_id uuid default null)
returns json
language plpgsql
security definer
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

    -- 개별 수업 예약마감이 명시돼 있으면(booking_deadline_min not null) 그 값이 이미 위에서
    -- "당일 포함 언제까지 예약 가능한지"를 전부 결정했으므로, 당일예약 허용 토글은 건너뛴다.
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

    -- [P2] 프라이빗 수업 동시 진행 제한 — 같은 센터·같은 시간대(겹치는 구간)에 이미
    -- 확정된 다른 프라이빗 수업이 설정된 한도만큼 있으면 더 예약할 수 없다.
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
      and m.remaining_count > 0
      and m.expires_at >= current_date
      and (
            not exists (select 1 from class_allowed_products cap where cap.class_id = v_class.id)
            or m.product_id in (select cap.product_id from class_allowed_products cap where cap.class_id = v_class.id)
      )
      and (
            m.product_id is null
            or not exists (select 1 from membership_schedule_rules r where r.product_id = m.product_id)
            or exists (
                select 1 from membership_schedule_rules r
                where r.product_id = m.product_id
                  and (r.day_of_week is null or r.day_of_week = v_day_of_week)
                  and (r.start_time is null or r.start_time = v_local_time)
                  and (r.class_title is null or v_class.title like '%' || r.class_title || '%')
            )
      )
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
        -- [P2] 프라이빗 수업은 정원 1명이 이미 찼으면 대기 없이 바로 거부한다.
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


create or replace function reserve_with_membership(
    p_class_id      uuid,
    p_profile_id    uuid,
    p_membership_id uuid
)
returns json
language plpgsql
security definer
as $$
declare
    v_class     record;
    v_mem       record;
    v_confirmed int;
    v_status    text;
    v_order     int;
    v_reservation_id uuid;
    v_local_date date;
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

    -- 개별 수업 예약마감이 명시돼 있으면 당일예약 허용 토글은 건너뛴다(reserve_class()와 동일).
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

    -- [P2] 프라이빗 수업 동시 진행 제한 (reserve_class()와 동일 로직).
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
      and m.remaining_count > 0
      and m.expires_at >= current_date
      and m.profile_id in (select id from profiles where account_id = my_account_id())
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
        -- [P2] 프라이빗 수업은 정원 1명이 이미 찼으면 대기 없이 바로 거부한다.
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

    return json_build_object('status', v_status, 'waitlist_order', v_order);
end;
$$;


create or replace function admin_assign_reservation(
    p_class_id        uuid,
    p_profile_id      uuid,
    p_assignment_type text,                 -- 'ADMIN_ASSIGNMENT' | 'ADMIN_FREE'
    p_membership_id   uuid default null,
    p_reason_code     text default null,
    p_reason_detail   text default null,
    p_force_capacity  boolean default false
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
    v_class          record;
    v_mem            record;
    v_confirmed      int;
    v_is_override    boolean := false;
    v_reason_detail  text;
    v_reservation_id uuid;
    v_admin_id       uuid;
begin
    if p_assignment_type not in ('ADMIN_ASSIGNMENT', 'ADMIN_FREE') then
        raise exception '잘못된 배치 방식이에요';
    end if;
    if p_reason_code is not null and p_reason_code not in (
        'MEMBER_REQUEST', 'MAKEUP_CLASS', 'TRIAL', 'EVENT',
        'SERVICE_COMPENSATION', 'CENTER_OPERATION', 'VIP_INVITATION',
        'ERROR_CORRECTION', 'OTHER'
    ) then
        raise exception '잘못된 배치 사유예요';
    end if;

    v_admin_id := my_account_id();

    -- 수업 확인 (행 잠금으로 동시 배치 경쟁 방지)
    select * into v_class from classes where id = p_class_id for update;
    if not found then
        raise exception '수업을 찾을 수 없어요';
    end if;
    if v_class.status = 'cancelled' then
        raise exception '수업이 취소되었어요';
    end if;
    if v_class.status = 'closed' then
        raise exception '현재 배치할 수 없는 수업이에요';
    end if;
    if v_class.start_time <= now() then
        raise exception '수업이 이미 시작되었어요';
    end if;

    -- 권한 확인 (해당 센터 관리자만)
    if not can_manage_center_reservations(v_class.center_id) then
        raise exception '관리자 권한이 없어요';
    end if;

    -- 회원 확인
    if not is_profile_assignable(p_profile_id) then
        raise exception '해당 회원을 찾을 수 없어요';
    end if;

    -- 중복 예약 확인 (타입 무관, 활성 예약 1건만 허용)
    if exists (
        select 1 from reservations
        where class_id = p_class_id and profile_id = p_profile_id
          and status in ('confirmed', 'waitlisted', 'attended')
    ) then
        raise exception '이미 이 수업에 예약된 회원이에요';
    end if;

    -- [P2] 프라이빗 수업 동시 진행 제한 — 관리자 직접배치도 이 설정을 피해가지 않는다.
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

    -- 배치 방식별 수강권 처리 (수강권 종류/예약조건 제한은 두 방식 모두 무시)
    if p_assignment_type = 'ADMIN_ASSIGNMENT' then
        if p_membership_id is null then
            raise exception '사용할 수강권을 선택해주세요';
        end if;
        select * into v_mem from memberships
        where id = p_membership_id and profile_id = p_profile_id
        for update;
        if not found then
            raise exception '수강권을 찾을 수 없어요';
        end if;
    else
        -- ADMIN_FREE: 클라이언트가 무엇을 보내든 신뢰하지 않고 서버가 무조건 무시
        p_membership_id := null;
    end if;

    -- 정원 확인 (최종 생성 시점 기준 재검증 — 동시 요청 대비)
    select count(*) into v_confirmed
    from reservations
    where class_id = p_class_id and status in ('confirmed', 'attended');

    if v_confirmed >= v_class.capacity then
        -- [P2] 프라이빗(1:1) 수업은 정원 초과 강제 배치 자체를 허용하지 않는다 —
        -- 그룹 수업의 "정원 초과 배치 확인" 흐름과 달리 override가 없다.
        if v_class.class_format = 'private' then
            raise exception '이미 다른 회원이 예약한 프라이빗 수업이라 추가로 배치할 수 없어요';
        end if;
        if not p_force_capacity then
            return json_build_object('needs_capacity_confirm', true);
        end if;
    end if;
    v_is_override := v_confirmed >= v_class.capacity;

    -- 배치 사유 검증 (서버 재검증 — 클라이언트 검증만 믿지 않음)
    if p_assignment_type = 'ADMIN_FREE' and p_reason_code is null then
        raise exception '무료 추가 배치 사유를 선택해주세요';
    end if;
    if v_is_override and p_reason_code is null then
        raise exception '정원 초과 배치 사유를 입력해주세요';
    end if;
    v_reason_detail := nullif(trim(coalesce(p_reason_detail, '')), '');
    if p_reason_code = 'OTHER' and v_reason_detail is null then
        raise exception '기타 사유를 입력해주세요';
    end if;
    if v_reason_detail is not null and char_length(v_reason_detail) > 200 then
        v_reason_detail := left(v_reason_detail, 200);
    end if;

    -- 예약 생성 (관리자 배치는 정원과 무관하게 항상 confirmed)
    insert into reservations (
        class_id, profile_id, membership_id, status,
        reservation_type, reservation_source, created_by_account_id,
        admin_reason_code, admin_reason_detail, is_capacity_override, membership_consumed
    ) values (
        p_class_id, p_profile_id, p_membership_id, 'confirmed',
        p_assignment_type, 'ADMIN', v_admin_id,
        p_reason_code, v_reason_detail, v_is_override, (p_assignment_type = 'ADMIN_ASSIGNMENT')
    ) returning id into v_reservation_id;

    if p_assignment_type = 'ADMIN_ASSIGNMENT' then
        update memberships set remaining_count = remaining_count - 1
        where id = p_membership_id and remaining_count is not null;
    end if;

    -- 작업 로그 (예약 생성과 같은 트랜잭션 — 함수 전체가 원자적이라 부분 성공 없음)
    insert into admin_action_logs (
        center_id, reservation_id, action_type, reservation_type, reservation_source,
        admin_id, member_profile_id, class_id, membership_id, source_unassigned_id,
        reason_code, reason_detail, capacity_override, membership_consumed,
        member_name_snapshot, class_title_snapshot, class_start_snapshot, after_state
    )
    select
        v_class.center_id, v_reservation_id,
        case when p_assignment_type = 'ADMIN_ASSIGNMENT' then 'CREATE_ASSIGNMENT' else 'CREATE_FREE' end,
        p_assignment_type, 'ADMIN',
        v_admin_id, p_profile_id, p_class_id, p_membership_id,
        case when p_assignment_type = 'ADMIN_ASSIGNMENT' then p_membership_id else null end,
        p_reason_code, v_reason_detail, v_is_override, (p_assignment_type = 'ADMIN_ASSIGNMENT'),
        coalesce(pr.nickname, pr.name, '회원'), v_class.title, v_class.start_time,
        json_build_object('reservation_id', v_reservation_id, 'status', 'confirmed')
    from profiles pr where pr.id = p_profile_id;

    return json_build_object(
        'reservation_id', v_reservation_id,
        'status', 'confirmed',
        'over_capacity', v_is_override
    );
end;
$$;
