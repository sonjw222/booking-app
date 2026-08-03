-- ============================================================
-- reserve_with_membership()에 운영설정 가드 이식
--
-- 실제 발견 경위: 관리자가 당일예약 OFF/예약 가능 기한 등을 저장해도 실제 회원
-- 브라우저에서는 계속 예약이 통과되는 버그가 재현됐다(수동 QA로 확인됨). reserve_class()
-- RPC를 직접 호출하는 테스트는 전부 정상으로 나왔는데, 이는 테스트가 잘못된 함수를 검증한
-- 것이었다 — 실제 예약 화면(app/reservation/page.tsx doReserve())은 회원이 사용 가능한
-- 수강권을 하나라도 갖고 있으면(거의 모든 실제 케이스) reserve_class()가 아니라
-- reserve_with_membership()을 호출한다(passPick이 채워지면 그쪽 우선, lib/reservations.ts).
--
-- reserve_with_membership()(add_admin_assignment.sql)을 직접 읽어보니 프로필 소유 확인,
-- 수업 상태(cancelled/closed), 지정한 수강권 유효성, 중복 예약, 정원만 확인하고
-- reserve_class()에 있는 아래 운영설정 가드가 전부 빠져 있었다:
--   - 수업 시작 후 예약 차단
--   - 예약 마감시간(booking_deadline_min 또는 calc_deadline('book'))
--   - 예약 오픈 시각(calc_deadline('open'))
--   - 당일 예약 허용 여부(allow_same_day_booking)
--   - 일일 예약 가능 횟수 제한(daily_book_limit_enabled/daily_book_limit)
--   - 센터 휴무일
--
-- 이 파일은 reserve_with_membership()의 기존 로직(지정된 수강권 검증, 정원/대기 처리,
-- 중복 예약 체크)은 그대로 두고, "수업 조회/상태 확인" 직후 위 6개 가드만 reserve_class()와
-- 동일한 조건으로 추가한다. 대기예약 주간 한도(waitlist_weekly_limit)는 reserve_class()에도
-- 있는 기존 로직이라 동일하게 추가한다(reserve_with_membership엔 이것도 없었음).
-- ============================================================

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

    -- 수업이 이미 시작됐으면 운영설정/개별 수업 마감값과 무관하게 무조건 차단
    -- (reserve_class()의 동일 체크와 대칭).
    if now() >= v_class.start_time then
        raise exception '수업이 시작되었습니다.';
    end if;

    -- 예약 마감시간 확인 — [CLASS-001] 개별 수업 override가 있으면 우선, 없으면 운영설정.
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

    -- 예약 오픈 시각 확인 — 설정이 없거나 계산이 안 되면 기존처럼 제한 없음.
    declare
        v_open_deadline timestamptz;
    begin
        v_open_deadline := calc_deadline(v_class.center_id, v_class.class_format, v_class.start_time, 'open');
        if v_open_deadline is not null and now() < v_open_deadline then
            raise exception '아직 예약이 열리지 않았어요';
        end if;
    end;

    -- 당일 예약 허용 여부 — 오늘(KST) 수업인데 설정이 꺼져 있으면 차단.
    if v_local_date = (now() at time zone 'Asia/Seoul')::date then
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

    -- 일일 예약 가능 횟수 제한 — 이 센터, 이 날짜(KST) 기준 확정+대기 합산.
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
        -- 대기예약 주간 한도 — reserve_class()에 있는 기존 로직과 동일하게 이곳에도 적용.
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
