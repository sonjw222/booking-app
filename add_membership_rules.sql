-- ============================================================
-- 수강권 예약조건 (상품 단위) 실연동
--
-- 하는 일:
--   1) membership_schedule_rules 를 상품(products) 단위로 변경
--      (기존 membership_id → product_id)
--   2) memberships 에 product_id 추가 (예약 시 조건 조회용)
--   3) reserve_class 가 상품 예약조건을 실제로 검사하게 교체
--   4) 조건 편집 정책 (pass.update 권한)
--
-- ⚠️ 기존에 membership_schedule_rules 에 데이터가 있었다면
--    membership_id 기반이라 삭제됩니다(테스트 데이터만 있을 것이므로 안전).
--
-- 파일 전체를 SQL Editor에 붙여넣고 Run 하세요.
-- 여러 번 실행해도 안전합니다.
-- ============================================================


-- ------------------------------------------------------------
-- [1] membership_schedule_rules 를 product_id 기반으로
-- ------------------------------------------------------------
-- 기존 membership_id 컬럼이 있으면 규칙을 비우고 컬럼 교체
--   (구조가 바뀌므로 기존 규칙 데이터는 유지 불가)
delete from membership_schedule_rules
where true;

alter table membership_schedule_rules drop column if exists membership_id;
alter table membership_schedule_rules add column if not exists product_id uuid;

-- product_id 는 필수. NULL 인 잔여 행이 없도록 위에서 비웠음
alter table membership_schedule_rules
    drop constraint if exists msr_product_fk;
alter table membership_schedule_rules
    add constraint msr_product_fk
    foreign key (product_id) references products(id) on delete cascade;


-- ------------------------------------------------------------
-- [2] memberships 에 product_id 추가
-- ------------------------------------------------------------
alter table memberships add column if not exists product_id uuid;
alter table memberships
    drop constraint if exists memberships_product_fk;
alter table memberships
    add constraint memberships_product_fk
    foreign key (product_id) references products(id);


-- ------------------------------------------------------------
-- [3] 예약조건 검사가 포함된 reserve_class 로 교체
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


-- ------------------------------------------------------------
-- [4] 예약조건 편집 정책
-- ------------------------------------------------------------
alter table membership_schedule_rules enable row level security;

drop policy if exists "예약조건 조회" on membership_schedule_rules;
create policy "예약조건 조회"
    on membership_schedule_rules for select
    using (auth.uid() is not null);

drop policy if exists "예약조건 생성" on membership_schedule_rules;
create policy "예약조건 생성"
    on membership_schedule_rules for insert
    with check (
        product_id in (select id from products where has_permission(center_id, 'pass.update'))
    );

drop policy if exists "예약조건 삭제" on membership_schedule_rules;
create policy "예약조건 삭제"
    on membership_schedule_rules for delete
    using (
        product_id in (select id from products where has_permission(center_id, 'pass.update'))
    );


-- ============================================================
-- 확인
-- ============================================================
select 'products' as t, count(*)::text from products
union all select 'rules', count(*)::text from membership_schedule_rules;


-- ============================================================
-- 완료!
--   → 매니저 대시보드 → "수강권 예약조건 설정"
--   → "+ 상품"으로 수강권 상품 만들기
--   → 상품마다 "+ 예약조건 추가" (요일·시간·수업명)
--
--   ※ 예약조건이 실제로 적용되려면, 회원의 memberships.product_id 가
--     그 상품과 연결돼 있어야 합니다. (결제 등록 시 상품 연결은 다음 단계)
--     지금은 product_id 가 비어있는 기존 수강권은 조건 없이 모두 예약 가능합니다.
-- ============================================================
