-- ============================================================
-- ⚠️ DRAFT / PROPOSED — DO NOT RUN unless explicitly approved ⚠️
-- P1-12: 운영설정(center_settings)의 저장된 값들이 실제 예약 로직에서 쓰이지 않는 문제
--
-- ⚠️ 이 파일은 P0-6(fix_holiday_membership_restore_draft_proposed.sql, 낮은 위험 — 특정
-- 상황에서만 호출되는 add_holiday_safe 하나만 수정)보다 훨씬 위험도가 높습니다.
-- reserve_class()는 앱에서 가장 많이 호출되는 핵심 RPC이고, 여기 추가하는 4개 검증은
-- 전에 없던 새 차단 조건입니다. **P0-6과 별도로, 더 신중하게 검토·승인해주세요** —
-- 같은 PR에 포함돼 있지만 반드시 같이 실행할 필요는 없습니다.
--
-- 조사 결과(전체 26개 필드 중 실제 배선 상태): docs/24_P1_12_Settings_Audit.md 참고.
-- 이 파일은 그중 "reserve_class()의 기존 동기 검증 흐름에 자연스럽게 추가 가능한" 4개만
-- 다룹니다. 나머지(자동폐강/대기자동승격 등 스케줄러가 필요한 것, private_slot_unit 등
-- 대응 UI가 아예 없는 것)는 이번에 손대지 않고 문서에만 기록했습니다.
--
-- 수정 대상: calc_deadline()에 'open'(예약 오픈 전 차단) kind 추가, reserve_class()에
-- 4개 검증 추가(예약 오픈 시각, 당일예약 허용, 일일예약 횟수 제한, 주간 대기예약 횟수 제한).
-- 기존 함수 시그니처·반환값·다른 호출부(admin_assign_reservation 등)는 전혀 바꾸지 않습니다.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1) calc_deadline()에 p_kind = 'open' 추가 — "아직 예약이 안 열림" 판정에 재사용.
--    기존 'book'/'cancel' 분기는 전혀 바꾸지 않음(순수 추가).
-- ------------------------------------------------------------
create or replace function calc_deadline(
    p_center_id uuid,
    p_class_format text,
    p_start_time timestamptz,
    p_kind text
)
returns timestamptz
language plpgsql stable
as $$
declare
    v_settings record;
    v_days int;
    v_time time;
    v_class_date date;
    v_deadline_date date;
begin
    select * into v_settings from center_settings where center_id = p_center_id;
    if not found then
        return null;   -- 설정 없음 → 폴백
    end if;

    if p_class_format = 'private' then
        if p_kind = 'book' then
            v_days := v_settings.private_book_days_before;
            v_time := v_settings.private_book_time;
        elsif p_kind = 'open' then
            v_days := v_settings.private_open_days_before;
            v_time := v_settings.private_open_time;
        else
            v_days := v_settings.private_cancel_days_before;
            v_time := v_settings.private_cancel_time;
        end if;
    else
        if p_kind = 'book' then
            v_days := v_settings.group_book_days_before;
            v_time := v_settings.group_book_time;
        elsif p_kind = 'open' then
            v_days := v_settings.group_open_days_before;
            v_time := v_settings.group_open_time;
        else
            v_days := v_settings.group_cancel_days_before;
            v_time := v_settings.group_cancel_time;
        end if;
    end if;

    v_class_date := (p_start_time at time zone 'Asia/Seoul')::date;
    v_deadline_date := v_class_date - make_interval(days => v_days);

    return ((v_deadline_date::text || ' ' || v_time::text) || '+09')::timestamptz;
end;
$$;


-- ------------------------------------------------------------
-- 2) reserve_class()에 4개 검증 추가:
--    - 예약 오픈 시각(수업일 N일 전 HH:MM부터 예약 가능, private/group 각각)
--    - 당일 예약 허용 여부(allow_same_day_booking)
--    - 일일 예약 가능 횟수(daily_book_limit_enabled/daily_book_limit)
--    - 주간 대기예약 가능 횟수(waitlist_weekly_limit, 0이면 대기 기능 자체 비활성화)
--    나머지 흐름(수강권 선택/정원 확인/확정-대기 처리)은 원래 함수 그대로.
-- ------------------------------------------------------------
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

    -- 예약 마감시간 확인 (기존 그대로)
    declare
        v_book_deadline timestamptz;
    begin
        v_book_deadline := calc_deadline(v_class.center_id, v_class.class_format, v_class.start_time, 'book');
        if v_book_deadline is null then
            v_book_deadline := v_class.start_time - make_interval(mins => v_class.booking_deadline_min);
        end if;
        if now() > v_book_deadline then
            raise exception '예약 마감시간이 지났어요';
        end if;
    end;

    -- [P1-12 신규] 예약 오픈 시각 확인 — 설정이 없거나(폴백 null) 계산이 안 되면 기존처럼 제한 없음
    declare
        v_open_deadline timestamptz;
    begin
        v_open_deadline := calc_deadline(v_class.center_id, v_class.class_format, v_class.start_time, 'open');
        if v_open_deadline is not null and now() < v_open_deadline then
            raise exception '아직 예약이 열리지 않았어요';
        end if;
    end;

    -- [P1-12 신규] 당일 예약 허용 여부 — 오늘(KST) 수업인데 설정이 꺼져 있으면 차단
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

    -- [P1-12 신규] 일일 예약 가능 횟수 제한 — 이 센터, 이 날짜(KST) 기준 확정+대기 합산
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
        -- [P1-12 신규] 대기예약 진입 전: 이 센터가 대기 기능을 쓰는지(주간 한도>0), 이번 주
        -- 한도를 넘지 않았는지 확인. 기존 "대기 등록" 로직 자체(차감 없이 순번만 부여)는 그대로.
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

COMMIT;
