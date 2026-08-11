-- ============================================================
-- add_class_trainers_pass_selection_mode_draft_proposed.sql 롤백
--
-- 4개 RPC를 이 Batch 적용 전(=2026-08-11 Phase1 P1-17 적용 직후) 라이브 본문으로 정확히
-- 복원하고, class_trainers RLS를 Batch 적용 전 상태(account_id 검증 없음)로 되돌리고,
-- classes.pass_selection_mode 컬럼을 제거한다.
--
-- ⚠ class_allowed_products 테이블 자체는 이 Batch가 단 한 행도 바꾸지 않았으므로(오직
-- classes.pass_selection_mode만 계산해 채움) 이 롤백도 class_allowed_products를 전혀
--건드리지 않는다 — 컬럼 삭제만으로 정확히 원상복구된다.
--
-- 여러 번 실행해도 안전(create or replace / drop if exists류 가드 포함).
-- ============================================================


-- ------------------------------------------------------------
-- 1) classes.pass_selection_mode 컬럼 제거
-- ------------------------------------------------------------

alter table classes drop column if exists pass_selection_mode;


-- ------------------------------------------------------------
-- 2) class_trainers RLS를 Batch 적용 전 상태로 복원(account_id 검증 없음,
--    reservation_functions.sql 원문 그대로)
-- ------------------------------------------------------------

drop policy if exists "매니저 강사 생성" on class_trainers;
create policy "매니저 강사 생성"
    on class_trainers for insert
    with check (class_id in (select id from classes where center_id in (select my_managed_center_ids())));

drop policy if exists "매니저 강사 수정" on class_trainers;
create policy "매니저 강사 수정"
    on class_trainers for update
    using (class_id in (select id from classes where center_id in (select my_managed_center_ids())))
    with check (class_id in (select id from classes where center_id in (select my_managed_center_ids())));


-- ------------------------------------------------------------
-- 3) usable_memberships / usable_memberships_for_classes
--    (Batch 적용 전 라이브 본문으로 복원)
-- ------------------------------------------------------------

create or replace function usable_memberships(p_class_id uuid, p_profile_id uuid)
returns table (
    membership_id   uuid,
    product_name    text,
    remaining_count int,
    expires_at      date,
    owner_profile   text,
    is_mine         boolean
)
language sql
security definer
as $$
    with cls as (
        select c.*,
               (c.start_time at time zone 'Asia/Seoul')::date as ldate,
               (c.start_time at time zone 'Asia/Seoul')::time as ltime,
               extract(dow from (c.start_time at time zone 'Asia/Seoul'))::int as ldow
        from classes c where c.id = p_class_id
    )
    select
        m.id,
        m.product_name,
        m.remaining_count,
        m.expires_at,
        coalesce(p.name, ''),
        (m.profile_id = p_profile_id)
    from memberships m
    join cls on true
    join products pd on pd.id = m.product_id
    left join profiles p on p.id = m.profile_id
    where m.center_id = cls.center_id
      and m.status = 'active'
      and pd.product_kind = 'pass'
      and (m.remaining_count is null or m.remaining_count > 0)
      and m.expires_at >= current_date
      and m.profile_id in (select id from profiles where account_id = my_account_id())
      and (
            not exists (select 1 from class_allowed_products cap where cap.class_id = cls.id)
            or m.product_id in (select cap.product_id from class_allowed_products cap where cap.class_id = cls.id)
      )
      and (
            -- [P1 override] 관리자가 이 class에 이 product를 명시적으로 지정했으면
            -- (class_allowed_products에 그 product_id가 있으면) membership_schedule_rules를
            -- 우회한다. "모든 수강권 허용"(class_allowed_products 0건)이면 이 exists는
            -- 항상 false이므로 기존 정책이 그대로 유지된다.
            exists (
                select 1 from class_allowed_products cap
                where cap.class_id = cls.id and cap.product_id = m.product_id
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
      )
    order by (m.profile_id = p_profile_id) desc, m.expires_at asc;
$$;


create or replace function usable_memberships_for_classes(p_class_ids uuid[], p_profile_id uuid)
returns table (
    class_id        uuid,
    membership_id   uuid,
    product_name    text,
    remaining_count int,
    expires_at      date,
    owner_profile   text,
    is_mine         boolean
)
language sql
security definer
as $$
    with cls as (
        select c.id, c.center_id, c.title,
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
        (m.profile_id = p_profile_id)
    from cls
    join memberships m on m.center_id = cls.center_id
    join products pd on pd.id = m.product_id
    left join profiles p on p.id = m.profile_id
    where m.status = 'active'
      and pd.product_kind = 'pass'
      and (m.remaining_count is null or m.remaining_count > 0)
      and m.expires_at >= current_date
      and m.profile_id in (select id from profiles where account_id = my_account_id())
      and (
            not exists (select 1 from class_allowed_products cap where cap.class_id = cls.id)
            or m.product_id in (select cap.product_id from class_allowed_products cap where cap.class_id = cls.id)
      )
      and (
            -- [P1 override] usable_memberships()와 동일한 override 조건
            exists (
                select 1 from class_allowed_products cap
                where cap.class_id = cls.id and cap.product_id = m.product_id
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
-- 4) reserve_class (Batch 적용 전 라이브 본문으로 복원)
-- ------------------------------------------------------------

create or replace function reserve_class(p_class_id uuid, p_profile_id uuid default null)
returns json
language plpgsql
security definer
as $function$
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
            -- [P1 override] 관리자가 이 class에 이 product를 명시적으로 지정했으면 schedule
            -- rule을 우회한다("모든 수강권 허용"이면 이 exists는 항상 false).
            exists (
                select 1 from class_allowed_products cap
                where cap.class_id = v_class.id and cap.product_id = m.product_id
            )
            or m.product_id is null
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
$function$;


-- ------------------------------------------------------------
-- 5) reserve_with_membership (Batch 적용 전 라이브 본문으로 복원)
-- ------------------------------------------------------------

create or replace function reserve_with_membership(p_class_id uuid, p_profile_id uuid, p_membership_id uuid)
returns json
language plpgsql
security definer
as $function$
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

    -- [P3] 이 수업에 class_allowed_products 지정이 있으면 그 수강권들만 허용한다
    -- (reserve_class()/usable_memberships_for_classes()와 동일 조건).
    -- [P1 신규] membership_schedule_rules 조건도 이 함수엔 지금까지 없었다 —
    -- reserve_class()/usable_memberships_for_classes()와 동일한 조건(override 포함)으로
    -- 새로 추가한다(목록 표시 정책과 실제 예약 성공 정책을 일치시킴).
    select m.* into v_mem
    from memberships m
    where m.id = p_membership_id
      and m.center_id = v_class.center_id
      and m.status = 'active'
      and m.remaining_count > 0
      and m.expires_at >= current_date
      and m.profile_id in (select id from profiles where account_id = my_account_id())
      and (
            not exists (select 1 from class_allowed_products cap where cap.class_id = v_class.id)
            or m.product_id in (select cap.product_id from class_allowed_products cap where cap.class_id = v_class.id)
      )
      and (
            exists (
                select 1 from class_allowed_products cap
                where cap.class_id = v_class.id and cap.product_id = m.product_id
            )
            or m.product_id is null
            or not exists (select 1 from membership_schedule_rules r where r.product_id = m.product_id)
            or exists (
                select 1 from membership_schedule_rules r
                where r.product_id = m.product_id
                  and (r.day_of_week is null or r.day_of_week = v_day_of_week)
                  and (r.start_time is null or r.start_time = v_local_time)
                  and (r.class_title is null or v_class.title like '%' || r.class_title || '%')
            )
      )
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

    -- ⚠ 아래 return문은 모바일 캡처로 100% 픽셀 대조는 못 했음(본문 위 헤더 주석 참고) —
    -- 예약 로직이 전부 끝난 뒤의 순수 반환값 구성이라 이번 정책 변경과는 무관하지만,
    -- 실행 전 이 한 줄만 대시보드에서 최종 대조 권장.
    return json_build_object('status', v_status, 'waitlist_order', v_order, 'reservation_id', v_reservation_id);
end;
$function$;

-- ============================================================
-- 완료. 4개 함수 모두 Batch 적용 전(2026-08-11 Phase1 P1-17 적용 직후) 상태로 복원됨.
-- class_trainers RLS도 account_id 검증 없는 원래 정책으로 복원됨.
-- classes.pass_selection_mode 컬럼 제거됨(class_allowed_products는 애초에 손대지 않아
-- 별도 복원 불필요).
-- ============================================================
