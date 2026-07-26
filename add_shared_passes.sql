-- ============================================================
-- 프로필 간 수강권 공유
--
-- 배경:
--   지금은 수강권이 "프로필"에 묶여 있어서, 대표 프로필로 산 수강권을
--   자녀 프로필 예약에 쓸 수 없었습니다.
--
-- 변경:
--   수강권을 "계정(아이디)" 단위로 공유합니다.
--   같은 계정의 어떤 프로필이든 그 계정이 보유한 수강권을 쓸 수 있어요.
--   예약 시 어떤 수강권을 쓸지 직접 고를 수도 있습니다.
--
-- 파일 전체를 SQL Editor에 붙여넣고 Run 하세요. 여러 번 실행해도 안전.
-- ============================================================

-- 어떤 프로필이 쓸 수 있는 수강권 목록 (같은 계정 전체)
create or replace function usable_memberships(p_class_id uuid, p_profile_id uuid)
returns table (
    membership_id   uuid,
    product_name    text,
    remaining_count int,
    expires_at      date,
    owner_profile   text,      -- 이 수강권이 지정된 프로필 이름
    is_mine         boolean    -- 선택한 프로필 본인 것인지
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
    left join profiles p on p.id = m.profile_id
    where m.center_id = cls.center_id
      and m.status = 'active'
      and m.remaining_count > 0
      and m.expires_at >= current_date
      -- ★ 같은 계정의 모든 프로필 수강권 허용
      and m.profile_id in (select id from profiles where account_id = my_account_id())
      -- 수업에 지정된 수강권이 있으면 그 목록에 포함돼야 함
      and (
            not exists (select 1 from class_allowed_products cap where cap.class_id = cls.id)
            or m.product_id in (select cap.product_id from class_allowed_products cap where cap.class_id = cls.id)
      )
      -- 수강권 예약조건(요일/시간/수업명)
      and (
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
    order by (m.profile_id = p_profile_id) desc, m.expires_at asc;
$$;


-- ============================================================
-- 수강권을 직접 지정해서 예약
--   p_membership_id 를 넘기면 그 수강권으로 예약 (계정 내 공유 허용)
-- ============================================================

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
begin
    -- 프로필이 내 계정 것인지
    if not exists (
        select 1 from profiles where id = p_profile_id and account_id = my_account_id()
    ) then
        raise exception '본인 계정의 프로필만 예약할 수 있어요';
    end if;

    select * into v_class from classes where id = p_class_id for update;
    if not found then raise exception '수업을 찾을 수 없어요'; end if;
    if v_class.status = 'cancelled' then raise exception '폐강된 수업이에요'; end if;
    if v_class.status = 'closed' then raise exception '예약이 마감된 수업이에요'; end if;

    -- 수강권이 내 계정 것인지 + 사용 가능한지
    select m.* into v_mem
    from memberships m
    where m.id = p_membership_id
      and m.center_id = v_class.center_id
      and m.status = 'active'
      and m.remaining_count > 0
      and m.expires_at >= current_date
      and m.profile_id in (select id from profiles where account_id = my_account_id())
    for update;
    if not found then
        raise exception '사용할 수 없는 수강권이에요';
    end if;

    -- 중복 예약 확인
    if exists (
        select 1 from reservations
        where class_id = p_class_id and profile_id = p_profile_id
          and status in ('confirmed', 'waitlisted', 'attended')
    ) then
        raise exception '이미 예약한 수업이에요';
    end if;

    -- 정원 확인 → 확정 또는 대기
    select count(*) into v_confirmed
    from reservations
    where class_id = p_class_id and status in ('confirmed', 'attended');

    if v_confirmed >= v_class.capacity then
        select coalesce(max(waitlist_order), 0) + 1 into v_order
        from reservations where class_id = p_class_id and status = 'waitlisted';
        v_status := 'waitlisted';
        insert into reservations (class_id, profile_id, membership_id, status, waitlist_order)
        values (p_class_id, p_profile_id, p_membership_id, v_status, v_order);
    else
        v_status := 'confirmed';
        insert into reservations (class_id, profile_id, membership_id, status)
        values (p_class_id, p_profile_id, p_membership_id, v_status);
        -- 확정일 때만 차감
        update memberships set remaining_count = remaining_count - 1
        where id = p_membership_id and remaining_count is not null;
    end if;

    return json_build_object('status', v_status, 'waitlist_order', v_order);
end;
$$;


-- ============================================================
-- 완료!
--   예약 화면에서 프로필 선택 → 사용할 수강권 선택 → 예약
-- ============================================================
