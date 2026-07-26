-- ============================================================
-- 수강권/상품 프로필 귀속 (사용 시점에 확정)
--
-- 규칙:
--   · 구매하면 "계정"에 속함 (아직 어느 프로필 것도 아님)
--   · 어떤 프로필로 처음 예약에 사용하면 → 그 프로필에 귀속
--   · 귀속된 뒤에는 그 프로필만 사용 가능
--
-- 예) 아이디에 프로필 A, B / 수강권1, 수강권2 보유
--     A로 예약 → 수강권1,2 중 선택 가능 (둘 다 미사용)
--     A가 수강권1 사용 → 수강권1은 A에 귀속
--     B로 예약 → 수강권2만 선택 가능
--
-- 파일 전체를 SQL Editor에 붙여넣고 Run 하세요. 여러 번 실행해도 안전.
-- ============================================================

-- 귀속 프로필 (null이면 아직 미사용 = 계정 내 누구나 사용 가능)
alter table memberships add column if not exists bound_profile_id uuid references profiles(id);

-- 이미 예약에 사용된 수강권은 그 프로필로 귀속시켜 두기 (1회성 정리)
update memberships m
set bound_profile_id = sub.profile_id
from (
    select distinct on (r.membership_id) r.membership_id, r.profile_id
    from reservations r
    where r.membership_id is not null
      and r.status in ('confirmed', 'waitlisted', 'attended')
    order by r.membership_id, r.created_at asc
) sub
where m.id = sub.membership_id
  and m.bound_profile_id is null;


-- ============================================================
-- 사용 가능한 수강권 목록 (귀속 규칙 반영)
--   · 미귀속(bound_profile_id is null) → 계정 내 아무 프로필이나 사용 가능
--   · 귀속됨 → 그 프로필만
-- ============================================================

create or replace function usable_memberships(p_class_id uuid, p_profile_id uuid)
returns table (
    membership_id   uuid,
    product_name    text,
    remaining_count int,
    expires_at      date,
    owner_profile   text,      -- 귀속된 프로필 이름 (미귀속이면 빈 문자열)
    is_mine         boolean    -- 이 프로필에 귀속된 것인지
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
        (m.bound_profile_id = p_profile_id)
    from memberships m
    join cls on true
    left join profiles p on p.id = m.bound_profile_id
    where m.center_id = cls.center_id
      and m.status = 'active'
      and m.remaining_count > 0
      and m.expires_at >= current_date
      -- 내 계정이 보유한 수강권
      and m.profile_id in (select id from profiles where account_id = my_account_id())
      -- ★ 귀속 규칙: 미귀속이거나, 이 프로필에 귀속된 것만
      and (m.bound_profile_id is null or m.bound_profile_id = p_profile_id)
      and (
            not exists (select 1 from class_allowed_products cap where cap.class_id = cls.id)
            or m.product_id in (select cap.product_id from class_allowed_products cap where cap.class_id = cls.id)
      )
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
    order by (m.bound_profile_id = p_profile_id) desc nulls last, m.expires_at asc;
$$;


-- ============================================================
-- 수강권 지정 예약 (사용 시 귀속 처리)
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
    if not exists (
        select 1 from profiles where id = p_profile_id and account_id = my_account_id()
    ) then
        raise exception '본인 계정의 프로필만 예약할 수 있어요';
    end if;

    select * into v_class from classes where id = p_class_id for update;
    if not found then raise exception '수업을 찾을 수 없어요'; end if;
    if v_class.status = 'cancelled' then raise exception '폐강된 수업이에요'; end if;
    if v_class.status = 'closed' then raise exception '예약이 마감된 수업이에요'; end if;

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

    -- ★ 귀속 확인: 이미 다른 프로필이 쓰는 수강권이면 거부
    if v_mem.bound_profile_id is not null and v_mem.bound_profile_id <> p_profile_id then
        raise exception '이 수강권은 다른 프로필이 사용 중이에요';
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
        select coalesce(max(waitlist_order), 0) + 1 into v_order
        from reservations where class_id = p_class_id and status = 'waitlisted';
        v_status := 'waitlisted';
        insert into reservations (class_id, profile_id, membership_id, status, waitlist_order)
        values (p_class_id, p_profile_id, p_membership_id, v_status, v_order);
    else
        v_status := 'confirmed';
        insert into reservations (class_id, profile_id, membership_id, status)
        values (p_class_id, p_profile_id, p_membership_id, v_status);
        update memberships set remaining_count = remaining_count - 1
        where id = p_membership_id and remaining_count is not null;
    end if;

    -- ★ 미귀속이면 이 프로필로 귀속 확정
    if v_mem.bound_profile_id is null then
        update memberships set bound_profile_id = p_profile_id where id = p_membership_id;
    end if;

    return json_build_object('status', v_status, 'waitlist_order', v_order);
end;
$$;


-- ============================================================
-- 확인
-- ============================================================
select
    count(*) filter (where bound_profile_id is null) as 미사용_수강권,
    count(*) filter (where bound_profile_id is not null) as 사용중_수강권
from memberships where status = 'active';


-- ============================================================
-- 완료!
-- ============================================================
