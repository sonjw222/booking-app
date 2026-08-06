-- ============================================================
-- P3: 수업별 사용 가능 수강권(class_allowed_products) — 서버 강제가 안 되던 경로 수정
--
-- 기존 구조 감사 결과(이미 구현돼 있던 것, 이번에 새로 만들지 않음):
--   - 관리자 UI(app/manager/classes/page.tsx)에 "예약 가능 수강권" 다중 선택 칩이 이미
--     있고, 등록/수정/반복등록 모두 lib/classes.ts의 setClassProducts/
--     setClassProductsBulk로 class_allowed_products를 정상적으로 채운다.
--   - 회원 화면(app/reservation/page.tsx)의 "사용할 수강권" 목록은
--     usable_memberships_for_classes()(fix_usable_memberships_product_kind.sql)가
--     이미 product_kind='pass' + class_allowed_products 둘 다 정확히 반영해서 만든다.
--   - reserve_class()(자동 매칭 경로)도 이미 class_allowed_products를 확인한다.
--
-- 실제로 빠져 있던 것 — reserve_with_membership()(회원이 화면에서 수강권을 "직접 선택"해
-- 예약하는 경로)는 class_allowed_products를 전혀 확인하지 않았다. 화면의 "사용할
-- 수강권" 목록 자체는 이미 걸러져 있어 정상적인 사용에서는 드러나지 않지만, 이
-- RPC를 직접 호출하면(다른 화면 버그, 재생 공격, API 직접 호출 등) 그 수업에 허용되지
-- 않은 수강권으로도 예약이 성립했다 — 서버가 최종 방어선이 아니었던 것.
-- reserve_class()/usable_memberships_for_classes()와 동일한 조건을 추가한다.
--
-- 추가로 발견한 관련 문제(같은 감사에서 확인, 별도 파일 없이 이 배치에 포함):
--   - class_allowed_products INSERT RLS는 "class_id가 내가 관리하는 센터 소속인지"만
--     확인하고, 그 product_id가 같은 센터의 pass 상품인지는 확인하지 않았다 — 정상
--     UI 경로는 항상 같은 센터의 pass만 보내지만(fetchProducts(centerId,"pass")),
--     RLS 자체가 이를 강제하진 않았다. product_id도 같은 센터·같은 product_kind='pass'
--     여야 한다는 조건을 추가해 "타 센터 수강권 혼입 금지"/"goods 절대 노출 금지"
--     원칙을 DB 레벨에서도 강제한다.
--
-- lib/reservations.ts의 fetchPurchasableProductsByClass()(별도 커밋, SQL 아님)도 같은
-- 감사에서 goods가 "구매 가능한 수강권" 추천에 섞여 나올 수 있던 버그를 발견해 함께
-- 고쳤다 — 이건 순수 프론트/쿼리 코드라 이 SQL 파일과 무관.
-- ============================================================

BEGIN;

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

    -- [P3] 이 수업에 class_allowed_products 지정이 있으면 그 수강권들만 허용한다
    -- (reserve_class()/usable_memberships_for_classes()와 동일 조건 — 회원이 화면에서
    -- 수강권을 직접 골라 예약하는 이 경로에만 빠져 있던 것을 추가).
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


-- [P3] class_allowed_products INSERT RLS 강화 — product_id도 같은 센터·pass여야 함
-- (기존엔 class_id의 센터만 확인해 이론상 타 센터 상품/goods를 직접 API로 연결할 수 있었음).
drop policy if exists "수업수강권 생성" on class_allowed_products;
create policy "수업수강권 생성"
    on class_allowed_products for insert
    with check (
        exists (
            select 1 from classes c
            join products p on p.id = class_allowed_products.product_id
            where c.id = class_allowed_products.class_id
              and c.center_id in (select my_managed_center_ids())
              and p.center_id = c.center_id
              and p.product_kind = 'pass'
        )
    );

COMMIT;
