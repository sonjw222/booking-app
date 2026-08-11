-- ============================================================
-- Batch: 담당 강사 복수 지정 + 수강권 허용 정책 변경(0건=전체허용 → 명시적 선택제)
--
-- [배경 — 실제 라이브 DB read-only 조사로 확정된 값]
--   total_classes = 474, zero_cap_classes(class_allowed_products 0건) = 389
--   (zero_cap_future = 343, zero_cap_past = 46)
--   실제(비-테스트) 센터 zero_cap = 55건 (그중 "어텐션 피겨팀" 47건 — future 25/예약 존재 16)
--   센터별 active pass 상품 수: 통합테스트센터 14개, 어텐션 피겨팀 7개, 센터1 2개, [TEST] 결제
--   통합테스트 전용 1개.
--   public.class_trainers 테이블은 이미 라이브 DB에 존재(신규 테이블 생성 불필요) — schema.sql/
--   reservation_functions.sql에 정의는 있으나 지금까지 어떤 앱 코드도 사용하지 않았음.
--
-- [정책 1 — 담당 강사]
--   class_trainers(class_id, account_id) 기존 테이블을 그대로 재사용. 강사 후보는
--   "스태프 & 권한"(manager_centers)의 해당 센터 status='active' 스태프 전체(역할 무관) —
--   center_roles.role_key='trainer'/manager_centers.specialty는 앱 코드 어디서도 쓰이지
--   않는 완전한 dead field라(grep으로 확인) 이번에 새 의미를 부여하지 않음.
--   기존 RLS는 class_id의 센터 소유만 확인하고 account_id가 그 센터 스태프인지 검증하지
--   않는 갭이 있어(타 센터 계정을 직접 API로 넣을 수 있었음) INSERT/UPDATE 정책을 강화한다.
--
-- [정책 2 — 수강권 허용(class_allowed_products) semantic 변경]
--   기존: 0건 = 모든 수강권 허용, 1건 이상 = 그 상품만 허용(P1-15/P1-17).
--   신규: 관리자가 반드시 1개 이상 선택해야 저장 가능(0개 선택 금지, 앱 레벨 가드).
--         "전체 허용"은 UI의 "전체 선택" 버튼으로 그 센터의 모든 active pass를 명시적으로
--         선택하는 방식으로 표현한다.
--
--   여기서 핵심 설계 결정: "전체 선택"이 실제로 모든 pass를 class_allowed_products에
--   행으로 채워 넣으면(스냅샷 방식) (a) 나중에 새 pass 상품이 추가돼도 이미 "전체 허용"으로
--   저장된 수업엔 자동으로 포함되지 않고(기존 0건=진짜 무조건 전체 허용이던 동작과 다른
--   회귀), (b) P1-17 override 조건("class_allowed_products에 행이 있으면 override")이
--   그대로면 "전체 허용" 수업의 모든 pass가 의도와 달리 schedule_rules를 전부 무시하게
--   된다(사용자가 이미 지적한 충돌).
--
--   대신 classes.pass_selection_mode('all'|'selected') 컬럼을 새로 추가해 "관리자 의도"를
--   행 개수가 아니라 명시적으로 저장한다:
--     - 'all'      : class_allowed_products는 채우지 않는다(0행 유지). 기존 "0건=전체허용"
--                    동작과 완전히 동일 — cap 체크를 완전히 우회하고, 새 pass가 나중에
--                    추가돼도 자동으로 포함된다(스냅샷 아님, 항상 "그 순간의 모든 pass").
--                    schedule_rules override는 발동하지 않는다(기존 P1-15/P1-17 동작 그대로).
--     - 'selected' : 관리자가 실제로 고른 product만 class_allowed_products에 저장한다
--                    (반드시 1개 이상). 그 상품들만 사용 가능하고, P1-17 override가 그
--                    상품들에 한해 발동한다(기존 "특정 지정" 동작 그대로).
--   "전체 선택" 버튼은 UI에서 그 센터의 모든 현재 pass 상품을 체크 표시하는 편의 기능일
--   뿐, 저장 시점에 실제로 선택된 개수가 그 센터의 pass 전체 개수와 같으면 mode='all',
--   그보다 적으면(0은 저장 자체가 막힘) mode='selected'로 저장한다 — 버튼을 눌렀는지
--   개별로 전부 체크했는지와 무관하게 "결과적으로 전체를 골랐는가"만으로 판정해 예측
--   가능하고 관리자가 헷갈리지 않게 한다.
--
--   [migration] 기존 474개 class 전부:
--     - class_allowed_products가 0건인 389개 → pass_selection_mode='all'(컬럼 기본값,
--       기존 동작과 100% 동일하게 보존 — class_allowed_products 행은 전혀 건드리지 않음).
--     - 1건 이상인 85개 → pass_selection_mode='selected'(기존 행 그대로 유지, 기존
--       "특정 지정 + override" 동작 100% 보존).
--   class_allowed_products 테이블 자체에는 이 migration이 단 한 행도 추가/삭제하지
--   않는다 — 오직 classes.pass_selection_mode 컬럼 값만 계산해 채운다. 이 덕분에 실제
--   센터 55건(그중 예약이 걸려 있는 16건 포함)과 미래 343건 전부 이번 migration으로
--   어떤 데이터도 변경되지 않고 정확히 기존과 동일하게 계속 동작한다(가장 안전한 이유).
--
-- [적용 대상 RPC]
--   usable_memberships / usable_memberships_for_classes(표시), reserve_class(자동매칭),
--   reserve_with_membership(회원 직접선택) — cap 체크와 P1-17 override 체크 두 조건절을
--   "class_allowed_products 행 존재 여부" 기준에서 "pass_selection_mode" 기준으로 바꾼다.
--   admin_assign_reservation은 이미 두 조건을 전부 무시하도록 설계돼 있어(Phase1 P1-17에서
--   확인) 이번에도 변경하지 않는다.
--
--   소스 오브 트루스: 2026-08-11 Phase1에서 사용자가 pg_get_functiondef()로 직접 추출해
--   적용을 확인한 라이브 본문(fix_membership_schedule_rule_override_draft_proposed.sql)을
--   기준으로 삼는다 — git의 reservation_functions.sql은 여전히 그보다 오래된 버전이라
--   기준으로 삼지 않는다. 두 조건절 외 다른 가드는 전혀 손대지 않는다.
--
-- 여러 번 실행해도 안전(create or replace / add column if not exists류 가드 포함).
-- ============================================================


-- ------------------------------------------------------------
-- 1) classes.pass_selection_mode 추가 + migration
-- ------------------------------------------------------------

alter table classes
    add column if not exists pass_selection_mode text not null default 'all'
    check (pass_selection_mode in ('all', 'selected'));

comment on column classes.pass_selection_mode is
    '수강권 허용 모드. all=이 센터의 모든 active pass 허용(class_allowed_products는 비워둠,
     schedule_rules override 미발동, 새 pass도 자동 포함). selected=class_allowed_products에
     명시적으로 저장된 product만 허용(1개 이상 필수, 그 product들에 한해 P1-17 override 발동).';

-- 기존 데이터 migration: class_allowed_products가 이미 있는 class만 'selected'로 표시.
-- (기본값이 이미 'all'이라 0건인 class는 손댈 필요 없음 — 이 UPDATE는 85개 행만 바꾼다.)
update classes
set pass_selection_mode = 'selected'
where id in (select distinct class_id from class_allowed_products);


-- ------------------------------------------------------------
-- 2) class_trainers RLS 강화 — account_id가 실제로 그 센터의 active 스태프인지 검증
-- ------------------------------------------------------------

drop policy if exists "매니저 강사 생성" on class_trainers;
create policy "매니저 강사 생성"
    on class_trainers for insert
    with check (
        exists (
            select 1
            from classes c
            join manager_centers mc on mc.center_id = c.center_id
            where c.id = class_trainers.class_id
              and c.center_id in (select my_managed_center_ids())
              and mc.account_id = class_trainers.account_id
              and mc.status = 'active'
        )
    );

drop policy if exists "매니저 강사 수정" on class_trainers;
create policy "매니저 강사 수정"
    on class_trainers for update
    using (
        exists (
            select 1 from classes c
            where c.id = class_trainers.class_id
              and c.center_id in (select my_managed_center_ids())
        )
    )
    with check (
        exists (
            select 1
            from classes c
            join manager_centers mc on mc.center_id = c.center_id
            where c.id = class_trainers.class_id
              and c.center_id in (select my_managed_center_ids())
              and mc.account_id = class_trainers.account_id
              and mc.status = 'active'
        )
    );

-- DELETE는 기존 그대로 유지(계정 검증 불필요 — 삭제는 새 account_id를 넣는 게 아님).
-- SELECT("수업 강사 조회")도 기존 그대로 유지(회원도 봐야 하므로 인증 사용자 전체 허용).


-- ------------------------------------------------------------
-- 3) usable_memberships / usable_memberships_for_classes
--    (2026-08-11 Phase1 적용 라이브 본문 기준, 변경분: cap 체크 + override 체크 두 곳만)
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
            -- [수강권 허용 정책 변경] 'all'이면 class_allowed_products 존재 여부와
            -- 무관하게 전부 허용(기존 "0건=전체허용"과 동일). 'selected'면 그 목록에
            -- 있는 product만 허용.
            cls.pass_selection_mode = 'all'
            or m.product_id in (select cap.product_id from class_allowed_products cap where cap.class_id = cls.id)
      )
      and (
            -- [P1-17 override, 정책 변경 반영] 'selected' 모드에서 이 product가 명시적으로
            -- 지정돼 있을 때만 override(schedule_rules 무시)한다. 'all' 모드는 override
            -- 대상이 아니다(모든 pass가 class_allowed_products에 없어도 허용되는 것과
            -- 마찬가지로, schedule_rules도 그대로 유지되는 기존 동작 보존).
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
-- 4) reserve_class
--    (2026-08-11 Phase1 적용 라이브 본문 기준, 변경분: membership 선택 WHERE절의 cap 체크 +
--    override 체크 두 곳만. 그 외(예약마감/오픈시각/당일예약/일일한도/휴무일/프라이빗
--    동시진행/대기예약 주간한도 등)는 전부 원문 그대로.)
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
            v_class.pass_selection_mode = 'all'
            or m.product_id in (select cap.product_id from class_allowed_products cap where cap.class_id = v_class.id)
      )
      and (
            (
                v_class.pass_selection_mode = 'selected'
                and exists (
                    select 1 from class_allowed_products cap
                    where cap.class_id = v_class.id and cap.product_id = m.product_id
                )
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
-- 5) reserve_with_membership
--    (2026-08-11 Phase1 적용 라이브 본문 기준, 변경분: membership 선택 WHERE절의 cap 체크 +
--    override 체크 두 곳만. 그 외는 전부 원문 그대로.)
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

    select m.* into v_mem
    from memberships m
    where m.id = p_membership_id
      and m.center_id = v_class.center_id
      and m.status = 'active'
      and m.remaining_count > 0
      and m.expires_at >= current_date
      and m.profile_id in (select id from profiles where account_id = my_account_id())
      and (
            v_class.pass_selection_mode = 'all'
            or m.product_id in (select cap.product_id from class_allowed_products cap where cap.class_id = v_class.id)
      )
      and (
            (
                v_class.pass_selection_mode = 'selected'
                and exists (
                    select 1 from class_allowed_products cap
                    where cap.class_id = v_class.id and cap.product_id = m.product_id
                )
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

    return json_build_object('status', v_status, 'waitlist_order', v_order, 'reservation_id', v_reservation_id);
end;
$function$;

-- ============================================================
-- 완료. 요약:
--   - classes.pass_selection_mode('all'|'selected') 신규 컬럼. 기존 474개 class 전부 기존
--     동작 100% 보존(0건→'all' 기본값 그대로, class_allowed_products 무변경 / 1건 이상→
--     'selected', 기존 행 무변경).
--   - class_trainers INSERT/UPDATE RLS 강화 — account_id가 그 센터의 active 스태프인지
--     이제 DB 레벨에서 검증됨. 새 테이블 생성 없음(기존 테이블 재사용).
--   - usable_memberships/usable_memberships_for_classes/reserve_class/reserve_with_membership
--     4개 함수의 cap 체크·P1-17 override 체크를 pass_selection_mode 기준으로 변경. 그 외
--     모든 가드는 전혀 손대지 않음.
--   - admin_assign_reservation은 변경 없음(이미 두 조건 모두 무시).
-- ============================================================
