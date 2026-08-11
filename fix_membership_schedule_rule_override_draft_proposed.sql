-- ============================================================
-- P1 신규 예약 정책: "관리자가 수업에서 직접 지정한 수강권은
-- membership_schedule_rules보다 우선한다"
--
-- [배경]
--   현재 정책(P1-15로 확정): class_allowed_products 허용 AND
--   membership_schedule_rules 충족 — 둘 다 통과해야 그 membership을
--   그 수업에 쓸 수 있음. "모든 수강권 허용"(class_allowed_products가
--   0건)이어도 membership_schedule_rules는 별개로 계속 적용된다.
--
-- [새 정책]
--   A. "모든 수강권 허용"(해당 class_id에 class_allowed_products 행이
--      0건)인 경우: 기존 정책 그대로 유지. membership_schedule_rules는
--      계속 적용된다.
--   B. 관리자가 그 수업에 특정 product를 class_allowed_products로
--      명시적으로 지정한 경우: 그 class-product 조합에 한해
--      membership_schedule_rules를 무시하고 사용할 수 있다(스케줄 규칙과
--      안 맞아도 그 수업에서는 사용 가능). 다른 product로 새지 않는다
--      (F 케이스) — class_allowed_products에 없는 product는 여전히 완전히
--      차단된다(기존 capOk 조건 변경 없음).
--   override가 우회하는 건 membership_schedule_rules뿐이다. status/
--   remaining_count/expires_at/product_kind='pass'/center 소속 등 다른
--   모든 정상 조건은 그대로 유지된다(아래 각 함수에서 그 부분은 단 한 글자도
--   손대지 않음).
--
-- [적용 대상 함수와 그 이유]
--   1. usable_memberships / usable_memberships_for_classes
--      (fix_usable_memberships_product_kind.sql) — 회원 화면 "사용 가능한
--      수강권" 목록(.pass-pick-list) 표시. 이번 세션 P1-15 작업에서 실제
--      라이브로 광범위하게 검증됨(변경 없음, override 조건절만 추가).
--   2. reserve_class — 회원이 자동 매칭으로 예약(수강권 미지정). 2026-08-11
--      실제 Supabase에서 pg_get_functiondef()로 직접 추출한 라이브 본문을
--      기준으로 함(사용자가 SQL Editor에서 직접 조회해 붙여넣음) — git의
--      reservation_functions.sql은 PR #32의 라이브 변경분(당일예약/일일
--      한도/오픈시각/예약마감 등)이 반영되지 않은 옛 버전이라 기준으로 삼지
--      않음(docs/TODO.md P2-16에 이미 문서화된 "git/실제 라이브 DB 불일치").
--      membership 선택 WHERE절의 schedule_rules 조건 한 곳만 바꾸고, 그 외
--      가드(예약마감/오픈시각/당일예약/일일한도/휴무일/프라이빗 동시진행/
--      대기예약 주간한도 등)는 전부 원문 그대로 보존.
--   3. reserve_with_membership — 회원이 화면에서 특정 수강권을 직접 골라
--      예약(app/reservation/page.tsx의 실제 예약 확정 경로, .pass-pick-list에서
--      선택 시 호출됨 — lib/reservations.ts:497). 2026-08-11 라이브 본문을
--      기준으로 함(사용자가 SQL Editor에서 직접 조회, 모바일 캡처 3회로 확인).
--
--      [이번에 함께 고치는 별도 발견]: 이 함수는 지금 class_allowed_products는
--      확인하지만 membership_schedule_rules는 전혀 확인하지 않는다(라이브
--      코드 자체의 주석: "회원이 화면에서 수강권을 직접 골라 예약하는 이
--      경로에만 빠져 있던 것을 추가" — class_allowed_products만 나중에
--      추가되고 membership_schedule_rules는 누락된 채로 남아 있었음).
--      lib/reservations.ts:364-366의 기존 주석("usable_memberships_for_classes()는
--      예약 시점에 실제로 쓰이는 usable_memberships()/reserve_with_membership()과
--      판정 조건이 동일해야 함 — 목록 표시와 실제 예약 가능 여부가 어긋나면
--      안 됨")이 이미 이 불변식을 요구하고 있었다 — 지금까지는 화면
--      목록(usable_memberships_for_classes)에서만 걸러지고 실제 RPC는
--      막지 않는 상태였다(정상 UI 흐름에서는 항상 그 목록에서 고르므로
--      실사용 영향은 제한적이나, 목록≠실제 RPC 정책 불일치 자체가 위험).
--      이번에 membership_schedule_rules 조건을 새로 추가하면서, 처음부터
--      override(B)까지 포함해서 넣는다 — 두 번 고치지 않기 위함.
--
--   4. admin_assign_reservation — 확인 결과 변경 불필요. 라이브 코드에 이미
--      "배치 방식별 수강권 처리 (수강권 종류/예약조건 제한은 두 방식 모두
--      무시)"라는 주석과 함께, ADMIN_ASSIGNMENT/ADMIN_FREE 둘 다
--      class_allowed_products도 membership_schedule_rules도 전혀 확인하지
--      않는 것으로 확인됨(2026-08-11 라이브 본문 직접 확인). 관리자 직접배치는
--      이미 이 두 제한을 전부 우회하도록 설계된, 이번 정책과는 별개의 더 넓은
--      범위의 기존 override다. 이 함수는 이 파일에서 전혀 건드리지 않는다.
--
-- [class_title 매칭 방식 불일치 — 이번에 고치지 않음, 별도 기존 문제로 기록]
--   usable_memberships/usable_memberships_for_classes는 r.class_title =
--   cls.title(정확히 일치), reserve_class/reserve_with_membership은
--   v_class.title like '%' || r.class_title || '%'(부분 일치)를 쓴다 —
--   서로 다른 매칭 규칙이 이미 라이브에 공존하고 있었다(이번 변경으로 만든
--   문제 아님). 각 함수의 기존 매칭 방식은 그대로 유지하고 손대지 않는다
--   (범위 밖 — docs/TODO.md에 별도 기록 예정).
--
-- [reserve_with_membership 마지막 return문 관련 참고]
--   모바일 화면 캡처 특성상 함수 맨 끝 return json_build_object(...) 줄의
--   정확한 마지막 글자까지는 픽셀 단위로 확인하지 못했다. 이 문서 하단에
--   그 줄을 이 파일이 실제로 어떻게 작성했는지 표시해 두었으니, 실행 전
--   Supabase 대시보드에서 그 한 줄만 최종 대조를 권장한다(이 줄은 예약
--   로직이 전부 끝난 뒤의 순수 반환값 구성이라 이번 정책 변경과는 무관함).
--
-- 여러 번 실행해도 안전(create or replace). 아래 4개 함수 모두 전체 본문을
-- 다시 정의하므로, 각 함수의 원래 라이브 본문과 한 줄씩 대조 가능하도록
-- 원문 구조/변수명/주석을 그대로 보존했다.
-- ============================================================


-- ------------------------------------------------------------
-- 1) usable_memberships / usable_memberships_for_classes
--    (fix_usable_memberships_product_kind.sql 기준, 변경분: override 조건절 추가만)
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
-- 2) reserve_class
--    2026-08-11 라이브 본문(pg_get_functiondef) 기준, 변경분: membership 선택
--    WHERE절의 schedule_rules 조건에 override 한 줄만 추가. 그 외 전부 원문 그대로.
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
-- 3) reserve_with_membership
--    2026-08-11 라이브 본문(pg_get_functiondef) 기준, 변경분:
--    (a) declare에 v_day_of_week/v_local_time 추가
--    (b) v_local_date 계산 직후 두 값 계산 추가(reserve_class와 동일 방식)
--    (c) membership 선택 WHERE절에 membership_schedule_rules 조건(override 포함)
--        신규 추가 — 지금까지 이 함수엔 이 조건 자체가 없었음
--    그 외(예약마감/오픈시각/당일예약/일일한도/휴무일/프라이빗 동시진행/
--    대기예약 주간한도/정원 확정·대기 분기)는 전부 원문 그대로.
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
-- 완료. 요약:
--   - usable_memberships / usable_memberships_for_classes / reserve_class /
--     reserve_with_membership 4개 함수 모두 "class_allowed_products에 이
--     product가 명시적으로 지정돼 있으면 membership_schedule_rules를
--     무시한다"는 동일한 override 조건을 갖게 됨.
--   - reserve_with_membership은 추가로 membership_schedule_rules 조건 자체가
--     새로 생김(기존엔 아예 없었음) — 목록 표시 정책과 실제 예약 정책이
--     이제 일치함.
--   - admin_assign_reservation은 변경 없음(이미 더 넓은 범위로 우회 중).
--   - status/remaining_count/expires_at/product_kind/center 소속/정원/
--     예약마감/휴무일/프라이빗 동시진행/대기예약 등 다른 모든 조건은 전혀
--     손대지 않음.
-- ============================================================
