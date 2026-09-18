-- ============================================================
-- MWHABIT Business Logic Fix Batch(2026-09-18) — 당일예약 허용 버그 수정
-- ============================================================
-- 발견 경위: Automated Business Scenario E2E Phase 3(SCN-P1-24a)가 실제 라이브 dev DB에
-- 대해 재현·고정한 버그. reserve_class()/reserve_with_membership() 둘 다 동일한 결함을
-- 갖고 있었다.
--
-- Root cause(실제 코드 감사 결과, 추측 아님):
--   calc_deadline(p_center_id, p_class_format, p_start_time, 'book')은 순수 날짜
--   산술이다(wire_settings.sql): v_deadline_date := class_date - group_book_days_before.
--   group_book_days_before의 기본값은 1(add_center_settings.sql) — 즉 당일(오늘) 수업의
--   예약 마감일은 "오늘 - 1일 = 어제"로 계산되어, 지금이 몇 시든 상관없이 항상 과거다.
--
--   reserve_class()는 이 날짜 기반 마감을 "예약 마감시간이 지났어요" 예외로 먼저
--   던지고, 그 아래에 있는 "당일예약 허용 여부(allow_same_day_booking)" 체크는 그
--   예외 때문에 코드 실행이 아예 거기까지 도달하지 못한다 — 관리자가 운영설정에서
--   "당일 예약 허용"을 켜도 group_book_days_before>=1인 한 당일예약은 100% 항상
--   거부된다. 즉 그 설정 자체가 사실상 죽은 코드였다.
--
-- 수정 정책:
--   당일(KST 기준 오늘) 수업에 대해:
--   1) 센터별 명시적 마감 오버라이드(classes.booking_deadline_min)가 있으면 그걸
--      그대로 쓴다(기존 동작 유지 — 관리자가 이 수업만 따로 마감을 정했다는 뜻이므로
--      당일예약 허용 토글보다 우선한다).
--   2) 오버라이드가 없으면:
--      a) allow_same_day_booking(기본값 true)이 꺼져 있으면 "당일 예약은 허용되지
--         않아요"로 명시적으로 차단한다(날짜 기반 마감이 우연히 미래를 가리키는
--         경우 — 예: group_book_days_before=0 — 에도 이 토글이 여전히 최종 권한을
--         갖도록, 날짜 기반 마감 계산보다 먼저 확인한다).
--      b) allow_same_day_booking이 켜져 있으면, 날짜 기반(N일 전) 마감 대신 수업
--         시작 시각을 마감으로 쓴다 — "허용되면 시작 전까지는 예약 가능"이라는
--         상식적인 의미로 되돌린다. group_book_days_before가 몇이든(0/1/2/...)
--         당일 여부 판정과 별개로 동작이 일관되게 정의된다(아래 표 참고).
--   그 외(당일이 아닌 수업)의 기존 날짜 기반 마감 계산 로직은 전혀 건드리지 않는다.
--
--   설정 조합별 의미(당일 수업 기준):
--     allow_same_day_booking=true  + booking_deadline_min 없음
--       → 수업 시작 전까지 예약 가능(당일예약 허용의 원래 의도)
--     allow_same_day_booking=false + booking_deadline_min 없음
--       → 당일예약 자체가 차단됨("당일 예약은 허용되지 않아요")
--     booking_deadline_min이 명시적으로 설정됨(개별 수업 오버라이드)
--       → allow_same_day_booking과 무관하게 그 값 그대로 적용(기존 동작 유지)
--
--   "수업 시작 이후에는 예약 불가"는 이 함수 상단의 별도 체크
--   (now() >= v_class.start_time → '수업이 시작되었습니다.')가 이미 담당하고 있고
--   이번 수정과 무관하게 그대로 유지된다.
--
-- 영향 범위: reserve_class()(일반 예약), reserve_with_membership()(수강권 지정 예약).
-- reserve_class_with_goods()는 내부적으로 reserve_class()를 호출하는 얇은 래퍼라
-- (reservation_functions.sql 확인) 별도 수정이 필요 없다.
--
-- 이 SQL은 Claude Code 세션에서 직접 실행되지 않았다 — 이 저장소에는 Supabase에 직접
-- SQL을 실행할 수 있는 수단(DATABASE_URL/직접 DB 연결)이 없으며, 실행 여부는 반드시
-- 사용자가 Supabase SQL Editor에서 직접 확인 후 실행해야 한다(CLAUDE.md 규칙 3/4).
-- ============================================================

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
    v_is_same_day    boolean;
    v_allow_same_day boolean;
    v_book_deadline  timestamptz;
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

    -- (2-3) 예약 마감시간 확인 — 당일예약 버그 수정(QA Fix Batch 2026-09-18)
    v_is_same_day := v_local_date = (now() at time zone 'Asia/Seoul')::date;

    if v_is_same_day and v_class.booking_deadline_min is null then
        select coalesce(allow_same_day_booking, true) into v_allow_same_day
        from center_settings where center_id = v_class.center_id;
        if not v_allow_same_day then
            raise exception '당일 예약은 허용되지 않아요';
        end if;
    end if;

    if v_class.booking_deadline_min is not null then
        v_book_deadline := v_class.start_time - make_interval(mins => v_class.booking_deadline_min);
    else
        v_book_deadline := calc_deadline(v_class.center_id, v_class.class_format, v_class.start_time, 'book');
        if v_book_deadline is null then
            v_book_deadline := v_class.start_time;
        end if;
        if v_is_same_day then
            -- 날짜 기반(N일 전) 마감은 당일 수업에는 항상 과거가 된다(N>=1일 때) —
            -- 당일예약이 허용된 경우(위에서 이미 차단되지 않고 여기 도달했다는 뜻)에는
            -- 그 값을 쓰지 않고 수업 시작 시각을 마감으로 삼는다.
            v_book_deadline := v_class.start_time;
        end if;
    end if;

    if now() > v_book_deadline then
        raise exception '예약 마감시간이 지났어요';
    end if;

    declare
        v_open_deadline timestamptz;
    begin
        v_open_deadline := calc_deadline(v_class.center_id, v_class.class_format, v_class.start_time, 'open');
        if v_open_deadline is not null and now() < v_open_deadline then
            raise exception '아직 예약이 열리지 않았어요';
        end if;
    end;

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
    v_is_same_day    boolean;
    v_allow_same_day boolean;
    v_book_deadline  timestamptz;
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

    -- 당일예약 버그 수정 — reserve_class()와 완전히 동일한 정책(위 파일 상단 설명 참고).
    v_is_same_day := v_local_date = (now() at time zone 'Asia/Seoul')::date;

    if v_is_same_day and v_class.booking_deadline_min is null then
        select coalesce(allow_same_day_booking, true) into v_allow_same_day
        from center_settings where center_id = v_class.center_id;
        if not v_allow_same_day then
            raise exception '당일 예약은 허용되지 않아요';
        end if;
    end if;

    if v_class.booking_deadline_min is not null then
        v_book_deadline := v_class.start_time - make_interval(mins => v_class.booking_deadline_min);
    else
        v_book_deadline := calc_deadline(v_class.center_id, v_class.class_format, v_class.start_time, 'book');
        if v_book_deadline is null then
            v_book_deadline := v_class.start_time;
        end if;
        if v_is_same_day then
            v_book_deadline := v_class.start_time;
        end if;
    end if;
    if now() > v_book_deadline then
        raise exception '예약 마감시간이 지났어요';
    end if;

    declare
        v_open_deadline timestamptz;
    begin
        v_open_deadline := calc_deadline(v_class.center_id, v_class.class_format, v_class.start_time, 'open');
        if v_open_deadline is not null and now() < v_open_deadline then
            raise exception '아직 예약이 열리지 않았어요';
        end if;
    end;

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

-- ============================================================
-- 적용 후 확인(read-only) — Supabase SQL Editor에서 아래를 실행해 두 함수가 새 버전으로
-- 교체됐는지 확인할 수 있다(본문에 "당일예약 버그 수정" 문자열이 포함돼 있어야 함).
-- ============================================================
-- select proname, pg_get_functiondef(oid) like '%당일예약 버그 수정%' as has_fix
-- from pg_proc where proname in ('reserve_class', 'reserve_with_membership');
