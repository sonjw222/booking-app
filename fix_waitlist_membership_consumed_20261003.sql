-- ============================================================
-- 대기예약 membership_consumed 일관성(2026-10-03) — reserve_class 자동선택 경로.
-- 문제: reservations.membership_consumed의 컬럼 기본값은 true다. reserve_with_membership은 대기 insert에 false를 명시하지만(확정은 true), reserve_class의 대기 insert는
--   membership_consumed를 생략해 기본값 true로 저장됐다 → status='waitlisted'인데 consumed=true(차감 없음)인 반대 방향 모순.
--   이 컬럼은 add_holiday_safe(휴무일 취소 시 수강권 복구 대상 판정), admin_cancel_reservation(ADMIN_ASSIGNMENT 복구), trg_notify_reservation_update(휴무 취소 알림의 "수강권 복구" 문구)가 쓴다.
-- 수정: Production 라이브 reserve_class 정의(예약 무결성 SQL 적용 후 상태)에서 두 insert만 바꿨다 — 확정 insert에 membership_consumed=true, 대기 insert에 false를 명시. 그 외 로직 변경 없음.
--   (이미 적용된 fix_reservation_integrity_20261003.sql은 historical artifact로 그대로 둔다.)
-- 선행 조건: fix_reservation_integrity_20261003.sql 적용됨(이 정의가 그 위의 상태). 대기 → 확정 승격 경로(cancel_reservation/update_class_safe)의 consumed=true는 fix_grant_schedule_and_kst_dates_20261003.sql에 있다.
-- 기존 데이터는 수정하지 않는다(Production 읽기 전용 확인: reservations 1건, 대기 0건). 진단은 diagnose_membership_consumed_20261003.sql(읽기 전용).
-- 이 세션에서는 production에 실행하지 않았습니다.
-- ============================================================
begin;

CREATE OR REPLACE FUNCTION public.reserve_class(p_class_id uuid, p_profile_id uuid DEFAULT NULL::uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
      -- [defense-in-depth] 자동선택 단계에서 active가 아닌 수강권(paused/expired/refunded/transferred 등)은 고르지 않는다.
      -- (PG 환불 lifecycle 트리거 reservations_guard_pg_refund_lock과 별개로 이 함수 자체가 상태 무결성을 보장)
      and m.status = 'active'
      and (m.remaining_count is null or m.remaining_count > 0)
      and (m.expires_at is null or m.expires_at >= (now() at time zone 'Asia/Seoul')::date)
      and (m.starts_at is null or m.starts_at <= (now() at time zone 'Asia/Seoul')::date)
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

        insert into reservations (class_id, profile_id, membership_id, status, membership_consumed)
        values (p_class_id, v_profile_id, v_membership.id, 'confirmed', true)   -- 확정 = 1회 차감됨
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

        insert into reservations (class_id, profile_id, membership_id, status, waitlist_order, membership_consumed)
        values (p_class_id, v_profile_id, v_membership.id, 'waitlisted', v_wait_order, false)   -- 대기 = 차감 없음(컬럼 기본값 true로 저장되던 것 수정)
        returning id into v_reservation_id;
    end if;

    return json_build_object('status', v_status, 'reservation_id', v_reservation_id);
end;
$function$;

commit;
