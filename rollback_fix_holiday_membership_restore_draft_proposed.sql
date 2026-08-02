-- ============================================================
-- ⚠️ DRAFT / PROPOSED — DO NOT RUN unless fix_holiday_membership_restore_draft_proposed.sql was applied ⚠️
-- P0-6 롤백 — add_holiday_safe()와 admin_action_logs.reservation_id FK를 수정 직전(수강권
-- 미복구 버그 + admin_action_logs FK 위반 버그가 모두 있는) 상태로 되돌린다.
-- 새 버그를 만들거나 예상치 못한 회귀가 발견됐을 때만 실행한다.
--
-- ⚠️ 주의: fix_*.sql 적용 이후 실제로 admin_action_logs.reservation_id가 SET NULL로 비워진
-- 행이 하나라도 생겼다면(= 그 사이 add_holiday_safe로 관리자배치 예약이 삭제된 적이 있다면)
-- 아래 `alter column reservation_id set not null`이 NOT NULL 위반으로 실패한다. 그 경우
-- 이 롤백을 실행하기 전에 그런 행을 수동으로 처리(재연결 불가 — 원본 예약이 이미 삭제됨)할지
-- 먼저 판단해야 한다.
-- ============================================================

BEGIN;

alter table admin_action_logs
    drop constraint if exists admin_action_logs_reservation_id_fkey;

alter table admin_action_logs
    add constraint admin_action_logs_reservation_id_fkey
    foreign key (reservation_id) references reservations(id);

alter table admin_action_logs
    alter column reservation_id set not null;

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
