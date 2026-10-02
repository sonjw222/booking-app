-- ============================================================
-- 예약 무결성 Release Blocker 수정(2026-10-03) — 예약조건 QA(F1~F5, F7)에서 발견된 서버 경계 문제.
-- 기준: origin/main 8fcd775 + Production 라이브 함수 정의(읽기 전용 pg_get_functiondef로 확인) — 오래된 *.sql 파일이 아니라 "지금 적용된" 정의를 기준으로 작성했다.
--
-- [F1] is_membership_eligible_for_class: 수업명을 c.title LIKE '%규칙%'로 비교 → '정규반' 규칙이 '정규반 심화'를 허용, '%'/'_' wildcard 악용 가능.
--      → 정확 일치(r.class_title = c.title)로 수정(usable_memberships* UI 함수와 동일). [F7] UI/서버 수업명 semantics 통일.
-- [F2] 'selected' 수업에서 class_allowed_products에 상품이 있으면 membership_schedule_rules를 건너뛰던 override 제거.
--      최종 규칙 = A(수업의 수강권 정책) AND B(예약조건: 없으면 통과/있으면 정확히 일치) AND C(bound 요일/시간).
--      서버 is_membership_eligible_for_class와 UI usable_memberships / usable_memberships_for_classes가 같은 의미가 된다.
--      reserve_class / reserve_with_membership / filter_eligible_class_ids / 자동예약(_auto_book_membership_core)은 모두 is_membership_eligible_for_class를 호출하므로 함께 고쳐진다.
-- [F3] 서버 최종 자격 함수에 product_kind='pass' 방어 추가(대여권 goods membership으로 수업 예약/차감 가능했음).
--      products가 없는 legacy/수동 membership(product_id IS NULL, Production에 1건 존재)은 기존 동작 보존.
-- [F4] reservations: authenticated/anon이 table-level UPDATE 권한 + "본인 예약 메모 수정" RLS(row만 제한)라서 회원이 REST로 class_id/membership_id/status 등을 직접 바꿀 수 있었다
--      (다른 센터 수업으로 이동, cancelled→confirmed 부활로 횟수 차감 없는 예약). 앱의 직접 UPDATE는 lib/mypage.ts의 member_memo 하나뿐이고, 관리자/서버 동작은
--      모두 SECURITY DEFINER RPC·트리거(owner 권한)라 영향이 없다. → authenticated의 UPDATE를 member_memo 컬럼으로만 제한, anon의 쓰기 권한 회수(RLS가 이미 막았지만 권한 자체를 제거).
--      service_role/postgres는 그대로. 정상 예약/취소/대기승격은 기존 RPC로만 이루어진다.
-- [F5] 회원 예약 자격의 starts_at/expires_at 비교가 DB TimeZone(UTC) 기준 current_date라 KST 00:00~08:59에 하루 어긋남 → (now() at time zone 'Asia/Seoul')::date로 통일
--      (reserve_class, reserve_with_membership, usable_memberships, usable_memberships_for_classes). memberships.starts_at/expires_at은 date 컬럼(한국 날짜 의미).
-- [보완] reserve_class 자동선택에 m.status = 'active'를 직접 추가(환불 lifecycle 트리거에 의존하지 않는 defense-in-depth), usable_memberships()의 날짜 조건을
--        usable_memberships_for_classes()와 동일하게(expires_at NULL 허용 + starts_at 검사) 맞춤. reservations INSERT/DELETE 권한은 이번에 확대하지 않는다(RLS 정책 없음 → 이미 직접 INSERT 불가).
-- [권한] is_membership_eligible_for_class는 PUBLIC/anon이 직접 실행 가능했다(SECURITY DEFINER 판정 oracle) → PUBLIC/anon 회수, authenticated/service_role 명시 유지.
--
-- 이번에 건드리지 않는 것: F6(manager_grant_product의 규칙 밖 bound 요일 지급 — 별도 follow-up), cancel_reservation/기타 함수의 current_date, 전화 검색, 진도 tree 등.
-- 이 세션에서는 production에 실행하지 않았습니다. 적용 전 verify_reservation_integrity_20261003.sql(읽기 전용)로 현재 상태를, 적용 후 같은 파일로 결과를 확인하세요.
-- rollback_fix_reservation_integrity_20261003.sql은 "이 migration 직전 라이브 정의/권한"을 그대로 복원한다.
-- ============================================================
begin;

-- [F1][F2][F3] 서버 최종 자격 판정
CREATE OR REPLACE FUNCTION public.is_membership_eligible_for_class(p_membership_id uuid, p_class_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
    select exists (
        select 1
        from memberships m
        join classes c on c.id = p_class_id
        where m.id = p_membership_id
          -- [F3] 수업 예약에는 pass 수강권만(대여권 등 goods 상품의 membership 차단). product_id가 없는 legacy/수동 membership은 기존 동작 유지.
          and (
                m.product_id is null
                or exists (select 1 from products pd where pd.id = m.product_id and pd.product_kind = 'pass')
          )
          -- A. 수업의 수강권 허용 정책: 'all'이면 통과, 'selected'면 class_allowed_products에 있는 상품만
          and (
                c.pass_selection_mode = 'all'
                or m.product_id in (select cap.product_id from class_allowed_products cap where cap.class_id = c.id)
          )
          -- B. 예약조건(membership_schedule_rules): 없으면 통과, 있으면 요일/시간/수업명이 "정확히" 맞는 규칙이 하나 이상.
          --    [F2] 'selected'에 지정된 상품이라는 이유로 이 조건을 건너뛰지 않는다(A AND B AND C). [F1] 수업명은 LIKE가 아니라 정확 일치(UI 후보 함수와 동일).
          and (
                m.product_id is null
                or not exists (select 1 from membership_schedule_rules r where r.product_id = m.product_id)
                or exists (
                    select 1 from membership_schedule_rules r
                    where r.product_id = m.product_id
                      and (r.day_of_week is null or r.day_of_week = extract(dow from (c.start_time at time zone 'Asia/Seoul'))::int)
                      and (r.start_time is null or r.start_time = (c.start_time at time zone 'Asia/Seoul')::time)
                      and (r.class_title is null or r.class_title = c.title)
                )
          )
          -- C. 구매 시 고른 요일/시간 귀속 — null이면(기존 상품/미선택) 제한 없음, 값이 있으면 수업의 실제 요일/시간과 일치해야 한다.
          and (
                m.bound_day_of_week is null
                or m.bound_day_of_week = extract(dow from (c.start_time at time zone 'Asia/Seoul'))::int
          )
          and (
                m.bound_start_time is null
                or m.bound_start_time = (c.start_time at time zone 'Asia/Seoul')::time
          )
    );
$function$;

-- [F2][F5] 회원 UI 후보(단일 수업)
CREATE OR REPLACE FUNCTION public.usable_memberships(p_class_id uuid, p_profile_id uuid)
 RETURNS TABLE(membership_id uuid, product_name text, remaining_count integer, expires_at date, owner_profile text, is_mine boolean)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
      -- [usable_memberships_for_classes와 동일] 무제한(expires_at NULL) 보존, 미래 시작(starts_at) 제외 — 둘 다 KST 날짜 기준
      and (m.expires_at is null or m.expires_at >= (now() at time zone 'Asia/Seoul')::date)
      and (m.starts_at is null or m.starts_at <= (now() at time zone 'Asia/Seoul')::date)
      and m.profile_id in (select id from profiles where account_id = my_account_id())
      and (
            -- [수강권 허용 정책 변경] 'all'이면 class_allowed_products 존재 여부와
            -- 무관하게 전부 허용(기존 "0건=전체허용"과 동일). 'selected'면 그 목록에
            -- 있는 product만 허용.
            cls.pass_selection_mode = 'all'
            or m.product_id in (select cap.product_id from class_allowed_products cap where cap.class_id = cls.id)
      )
      and (
            -- [F2] 'selected' 지정 상품도 예약조건을 건너뛰지 않는다(서버 is_membership_eligible_for_class와 동일: A AND B AND C)
            m.product_id is null
            or not exists (select 1 from membership_schedule_rules r where r.product_id = m.product_id)
            or exists (
                select 1 from membership_schedule_rules r
                where r.product_id = m.product_id
                  and (r.day_of_week is null or r.day_of_week = cls.ldow)
                  and (r.start_time is null or r.start_time = cls.ltime)
                  and (r.class_title is null or r.class_title = cls.title)
            )
      )
      -- [Batch C 신규] 구매 시 고른 요일/시간 귀속(is_membership_eligible_for_class와 동일 조건)
      and (m.bound_day_of_week is null or m.bound_day_of_week = cls.ldow)
      and (m.bound_start_time is null or m.bound_start_time = cls.ltime)
    order by (m.profile_id = p_profile_id) desc, m.expires_at asc;
$function$;

-- [F2][F5] 회원 UI 후보(여러 수업)
CREATE OR REPLACE FUNCTION public.usable_memberships_for_classes(p_class_ids uuid[], p_profile_id uuid)
 RETURNS TABLE(class_id uuid, membership_id uuid, product_name text, remaining_count integer, expires_at date, owner_profile text, is_mine boolean, issued_at date)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
        (m.profile_id = p_profile_id),
        m.issued_at
    from cls
    join memberships m on m.center_id = cls.center_id
    join products pd on pd.id = m.product_id
    left join profiles p on p.id = m.profile_id
    where m.status = 'active'
      and pd.product_kind = 'pass'
      and (m.remaining_count is null or m.remaining_count > 0)
      and (m.expires_at is null or m.expires_at >= (now() at time zone 'Asia/Seoul')::date)
      and (m.starts_at is null or m.starts_at <= (now() at time zone 'Asia/Seoul')::date)
      and m.profile_id in (select id from profiles where account_id = my_account_id())
      and (
            cls.pass_selection_mode = 'all'
            or m.product_id in (select cap.product_id from class_allowed_products cap where cap.class_id = cls.id)
      )
      and (
            -- [F2] 'selected' 지정 상품도 예약조건을 건너뛰지 않는다(서버 is_membership_eligible_for_class와 동일: A AND B AND C)
            m.product_id is null
            or not exists (select 1 from membership_schedule_rules r where r.product_id = m.product_id)
            or exists (
                select 1 from membership_schedule_rules r
                where r.product_id = m.product_id
                  and (r.day_of_week is null or r.day_of_week = cls.ldow)
                  and (r.start_time is null or r.start_time = cls.ltime)
                  and (r.class_title is null or r.class_title = cls.title)
            )
      )
      -- [Batch C 신규] 구매 시 고른 요일/시간 귀속(is_membership_eligible_for_class와 동일 조건)
      and (m.bound_day_of_week is null or m.bound_day_of_week = cls.ldow)
      and (m.bound_start_time is null or m.bound_start_time = cls.ltime);
$function$;

-- [F5] 예약(자동 수강권 선택)
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
$function$;

-- [F5] 예약(수강권 지정)
CREATE OR REPLACE FUNCTION public.reserve_with_membership(p_class_id uuid, p_profile_id uuid, p_membership_id uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
      and (m.expires_at is null or m.expires_at >= (now() at time zone 'Asia/Seoul')::date)
      and (m.starts_at is null or m.starts_at <= (now() at time zone 'Asia/Seoul')::date)
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
$function$;

-- 함수 권한: is_membership_eligible_for_class만 PUBLIC/anon 회수(나머지 함수는 이미 authenticated 전용). create or replace는 기존 권한을 유지한다.
revoke all on function public.is_membership_eligible_for_class(uuid, uuid) from public, anon;
grant execute on function public.is_membership_eligible_for_class(uuid, uuid) to authenticated, service_role;

-- [F4] reservations 직접 UPDATE 범위 축소
revoke update on table public.reservations from authenticated;
grant update (member_memo) on table public.reservations to authenticated;   -- 앱의 유일한 직접 UPDATE(lib/mypage.ts 예약 메모). 행 제한은 기존 "본인 예약 메모 수정" RLS가 계속 담당.
revoke insert, update, delete, truncate on table public.reservations from anon;
revoke truncate on table public.reservations from authenticated;

commit;
