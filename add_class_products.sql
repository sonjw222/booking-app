-- ============================================================
-- 수강권/상품 체계 개편 + 수업별 예약가능 수강권 지정
--
-- 하는 일:
--   1) products 에 product_kind(pass/goods) + unlimited 컬럼 추가
--      - pass = 수강권(수업 예약용), goods = 대여·물품(피겨화 대여 등)
--   2) class_allowed_products 테이블 신설 (수업 ↔ 예약가능 수강권, N:N)
--   3) reserve_class 가 이 지정을 검사하도록 교체
--      - 수업에 수강권이 지정돼 있으면 그 수강권으로만 예약 가능
--      - 지정이 없으면 종전대로 (모든 수강권 가능)
--
-- 파일 전체를 SQL Editor에 붙여넣고 Run 하세요. 여러 번 실행해도 안전.
-- ============================================================


-- ------------------------------------------------------------
-- [1] products 컬럼 추가
-- ------------------------------------------------------------
alter table products add column if not exists product_kind text not null default 'pass';
alter table products add column if not exists unlimited boolean not null default false;

-- 체크 제약 (이미 있으면 무시)
do $$
begin
    if not exists (select 1 from pg_constraint where conname = 'products_kind_check') then
        alter table products add constraint products_kind_check check (product_kind in ('pass','goods'));
    end if;
end $$;


-- ------------------------------------------------------------
-- [2] 수업별 예약가능 수강권 테이블
-- ------------------------------------------------------------
create table if not exists class_allowed_products (
    id          uuid primary key default gen_random_uuid(),
    class_id    uuid not null references classes(id) on delete cascade,
    product_id  uuid not null references products(id) on delete cascade,
    created_at  timestamptz not null default now(),
    unique (class_id, product_id)
);

alter table class_allowed_products enable row level security;

drop policy if exists "수업수강권 조회" on class_allowed_products;
create policy "수업수강권 조회"
    on class_allowed_products for select
    using (auth.uid() is not null);

drop policy if exists "수업수강권 생성" on class_allowed_products;
create policy "수업수강권 생성"
    on class_allowed_products for insert
    with check (
        class_id in (select id from classes where center_id in (select my_managed_center_ids()))
    );

drop policy if exists "수업수강권 삭제" on class_allowed_products;
create policy "수업수강권 삭제"
    on class_allowed_products for delete
    using (
        class_id in (select id from classes where center_id in (select my_managed_center_ids()))
    );


-- ------------------------------------------------------------
-- [3] reserve_class 교체 (수업-수강권 지정 검사 포함)
-- ------------------------------------------------------------
create or replace function reserve_class(p_class_id uuid, p_profile_id uuid default null)
returns json
language plpgsql
security definer  -- RLS를 우회해서 함수 안에서 검증을 직접 수행
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
    -- (1) 예약할 프로필 결정
    --     p_profile_id 를 넘기면 그 프로필, 안 넘기면 본인 대표 프로필
    if p_profile_id is not null then
        -- 내 계정 소유의 프로필인지 확인
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

    -- (2) 수업 정보 확인 (행 잠금으로 동시 예약 경쟁 방지)
    select * into v_class from classes where id = p_class_id for update;
    if not found then
        raise exception '수업을 찾을 수 없어요';
    end if;

    -- 한국시간 기준 날짜/시간/요일 (서버는 UTC라서 변환 필수!)
    v_local_date := (v_class.start_time at time zone 'Asia/Seoul')::date;
    v_local_time := (v_class.start_time at time zone 'Asia/Seoul')::time;
    v_day_of_week := extract(dow from (v_class.start_time at time zone 'Asia/Seoul'))::int;

    -- (2-1) 폐강/마감된 수업인지 확인
    if v_class.status = 'cancelled' then
        raise exception '폐강된 수업이에요';
    end if;
    if v_class.status = 'closed' then
        raise exception '예약이 마감된 수업이에요';
    end if;

    -- (2-2) 승인된 센터인지 확인 (승인대기 센터는 예약 불가)
    if not exists (
        select 1 from centers where id = v_class.center_id and status = 'approved'
    ) then
        raise exception '아직 승인되지 않은 센터예요';
    end if;

    -- (2-3) 예약 마감시간 확인
    --   센터 설정(N일 전 HH:MM)이 있으면 그걸 쓰고,
    --   없으면 기존 classes.booking_deadline_min(분 단위)로 폴백
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

    -- (3) 센터 휴무일 확인
    if exists (
        select 1 from center_holidays
        where center_id = v_class.center_id
          and holiday_date = v_local_date
    ) then
        raise exception '센터 휴무일이라 예약할 수 없어요';
    end if;

    -- (4) 중복 예약 확인
    if exists (
        select 1 from reservations
        where class_id = p_class_id and profile_id = v_profile_id
          and status in ('confirmed', 'waitlisted')
    ) then
        raise exception '이미 예약(또는 대기)한 수업이에요';
    end if;

    -- (5) 사용 가능한 수강권 찾기
    --     조건: 해당 센터 + 잔여횟수 있음 + 기간 유효
    --     수강권에 요일/시간 조건(membership_schedule_rules)이 있으면 그 조건도 통과해야 함
    select m.* into v_membership
    from memberships m
    where m.profile_id = v_profile_id
      and m.center_id = v_class.center_id
      and m.remaining_count > 0
      and m.expires_at >= current_date
      -- 수업에 예약가능 수강권이 지정돼 있으면(class_allowed_products), 그 목록에 포함돼야 함
      and (
            not exists (select 1 from class_allowed_products cap where cap.class_id = v_class.id)
            or m.product_id in (select cap.product_id from class_allowed_products cap where cap.class_id = v_class.id)
      )
      and (
            -- 조건이 하나도 없으면 통과 (상품에 규칙이 없거나, product_id 미연결)
            m.product_id is null
            or not exists (select 1 from membership_schedule_rules r where r.product_id = m.product_id)
            -- 조건이 있으면 하나라도 매칭돼야 통과
            or exists (
                select 1 from membership_schedule_rules r
                where r.product_id = m.product_id
                  and (r.day_of_week is null or r.day_of_week = v_day_of_week)
                  and (r.start_time is null or r.start_time = v_local_time)
                  and (r.class_title is null or v_class.title like '%' || r.class_title || '%')
            )
      )
    order by m.expires_at asc   -- 만료 임박한 수강권부터 사용
    limit 1
    for update;

    if not found then
        raise exception '이 수업에 사용할 수 있는 수강권이 없어요 (잔여횟수/기간/예약조건을 확인해주세요)';
    end if;

    -- (6) 정원 확인 → 확정 또는 대기
    select count(*) into v_confirmed
    from reservations
    where class_id = p_class_id and status = 'confirmed';

    if v_confirmed < v_class.capacity then
        -- 확정 예약: 수강권 1회 차감
        v_status := 'confirmed';
        update memberships set remaining_count = remaining_count - 1
        where id = v_membership.id;

        insert into reservations (class_id, profile_id, membership_id, status)
        values (p_class_id, v_profile_id, v_membership.id, 'confirmed')
        returning id into v_reservation_id;
    else
        -- 대기 등록: 차감하지 않고 순번만 부여 (확정 전환될 때 차감)
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


-- ============================================================
-- 확인
-- ============================================================
select column_name from information_schema.columns
where table_name='products' and column_name in ('product_kind','unlimited');
select count(*) as 수업수강권연결 from class_allowed_products;


-- ============================================================
-- 완료!
--   → 수업 관리 → 수업 등록/수정 → "예약 가능 수강권" 선택
--     (선택 안 하면 모든 수강권 가능, 특정 수강권만 고르면 그것만)
--   → 상품 관리(대여·물품)는 별도 메뉴에서 관리
-- ============================================================

