-- ============================================================
-- 수강권 판정 로직을 "계정 공유" 기준으로 통일
--
-- 배경:
--   usable_memberships() / reserve_with_membership() 함수가
--   add_pass_binding.sql(귀속 방식, bound_profile_id)과
--   add_shared_passes.sql(공유 방식, profile_id만 사용)
--   두 파일에서 서로 다르게 정의되어 있었습니다. 실제 Supabase 프로젝트에
--   어느 파일을 나중에 실행했는지에 따라 지금 살아있는 로직이 달랐습니다.
--
--   운영 기준을 "공유 방식"으로 확정하고 이 파일로 최종 고정합니다.
--   bound_profile_id 컬럼 자체는 삭제하지 않습니다(다른 곳에서 참조하는지
--   불확실하므로 스키마 변경은 최소화 — 필요하면 별도 승인 후 정리).
--
-- 추가:
--   예약창의 수업 목록에서 여러 수업의 "사용 가능한 수강권"을 한 번에
--   조회하기 위한 usable_memberships_for_classes()를 새로 추가합니다.
--   ⚠ 이 함수는 usable_memberships()와 WHERE 조건이 항상 동일해야 합니다 —
--     목록에 보이는 "사용 가능"과 예약 시점의 실제 사용 가능 여부가
--     어긋나면 안 되기 때문입니다. 한쪽을 고치면 반드시 다른 쪽도 같이 고치세요.
--
-- 파일 전체를 SQL Editor에 붙여넣고 Run 하세요. 여러 번 실행해도 안전.
-- ============================================================

-- 1) 단일 수업 기준 (예약 확인 모달에서 사용) — 공유 로직으로 재고정
create or replace function usable_memberships(p_class_id uuid, p_profile_id uuid)
returns table (
    membership_id   uuid,
    product_name    text,
    remaining_count int,
    expires_at      date,
    owner_profile   text,      -- 이 수강권을 산 프로필 이름
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
      -- 같은 계정의 모든 프로필 수강권 공유 허용
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
-- 2) 여러 수업 기준 (예약창 수업 목록 - 한 번에 조회, N+1 방지)
--    ⚠ 위 usable_memberships()와 판정 조건을 반드시 동일하게 유지할 것
-- ============================================================
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
    left join profiles p on p.id = m.profile_id
    where m.status = 'active'
      and m.remaining_count > 0
      and m.expires_at >= current_date
      and m.profile_id in (select id from profiles where account_id = my_account_id())
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
      );
$$;


-- ============================================================
-- 3) 수강권 지정 예약 — 공유 로직으로 재고정 (귀속 검사 제거)
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
--   usable_memberships / usable_memberships_for_classes / reserve_with_membership
--   세 함수 모두 "계정 공유" 기준으로 통일되었습니다.
-- ============================================================
