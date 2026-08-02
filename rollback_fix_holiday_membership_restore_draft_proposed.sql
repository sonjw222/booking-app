-- ============================================================
-- ⚠️ DRAFT / PROPOSED — DO NOT RUN unless fix_holiday_membership_restore_draft_proposed.sql was applied ⚠️
-- P0-6 롤백 — add_holiday_safe()를 수정 직전(수강권 미복구 버그가 있는) 상태로 되돌린다.
-- 새 버그를 만들거나 예상치 못한 회귀가 발견됐을 때만 실행한다.
-- ============================================================

BEGIN;

create or replace function add_holiday_safe(
    p_center_id uuid,
    p_date date,
    p_reason text default null,
    p_force boolean default false
)
returns json
language plpgsql
security definer
as $$
declare
    v_class_ids  uuid[];
    v_active_cnt int;
begin
    if not has_permission(p_center_id, 'schedule.own.group.delete') and not is_platform_admin() then
        raise exception '휴무일을 지정할 권한이 없어요';
    end if;

    select array_agg(id) into v_class_ids
    from classes
    where center_id = p_center_id
      and (start_time at time zone 'Asia/Seoul')::date = p_date;

    v_active_cnt := 0;
    if v_class_ids is not null then
        select count(*) into v_active_cnt
        from reservations
        where class_id = any(v_class_ids)
          and status in ('confirmed','waitlisted','attended');
    end if;

    if v_active_cnt > 0 and not p_force then
        return json_build_object(
            'needs_confirm', true,
            'class_count', coalesce(array_length(v_class_ids, 1), 0),
            'reservation_count', v_active_cnt
        );
    end if;

    if v_class_ids is not null then
        delete from reservations where class_id = any(v_class_ids);
        delete from classes where id = any(v_class_ids);
    end if;

    insert into center_holidays (center_id, holiday_date, reason)
    values (p_center_id, p_date, p_reason)
    on conflict do nothing;

    return json_build_object(
        'needs_confirm', false,
        'deleted_classes', coalesce(array_length(v_class_ids, 1), 0),
        'cancelled_reservations', v_active_cnt
    );
end;
$$;

COMMIT;
