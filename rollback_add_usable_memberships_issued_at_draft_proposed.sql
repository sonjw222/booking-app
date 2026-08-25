-- ============================================================
-- add_usable_memberships_issued_at_draft_proposed.sql 롤백
-- issued_at 컬럼 추가 이전(add_class_trainers_pass_selection_mode_draft_proposed.sql이
-- 정의했던 7컬럼짜리) 원문 그대로 되돌린다. WHERE절은 여기서도 전혀 안 바뀜.
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
set search_path = public
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
