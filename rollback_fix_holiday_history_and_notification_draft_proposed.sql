-- ============================================================
-- ⚠️ DRAFT / PROPOSED — DO NOT RUN unless fix_holiday_history_and_notification_draft_proposed.sql was applied ⚠️
-- NOTIF-001(E-4/E-5) 롤백 — add_holiday_safe()와 trg_notify_reservation_update()를 이
-- 배치 적용 직전(= PR #32 적용 후, 즉 수강권 복구는 있지만 DELETE 기반이고 알림 문구
-- 강화는 없는 상태)으로 정확히 되돌린다. P0-6 이전(수강권 미복구 버그) 상태로 되돌리는
-- 것이 아니다.
--
-- ⚠️ 주의: 이 배치 적용 이후 실제로 휴무일 강제취소가 한 번이라도 일어났다면, 그 예약들은
-- 이제 DELETE가 아니라 status='cancelled'인 채로 남아있다. 이 롤백은 그 행들을 다시
-- 지우지 않는다(과거로 되돌리는 개념이 아니라 "이후 동작 방식"만 되돌리는 것) — 이미
-- cancelled로 남은 이력 데이터는 그대로 유지된다(오히려 안전한 결과).
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
        update memberships m
        set remaining_count = remaining_count + sub.cnt
        from (
            select r.membership_id, count(*) as cnt
            from reservations r
            where r.class_id = any(v_class_ids)
              and r.status in ('confirmed', 'attended')
              and r.membership_consumed
              and r.membership_id is not null
            group by r.membership_id
        ) sub
        where m.id = sub.membership_id
          and m.remaining_count is not null;

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


create or replace function trg_notify_reservation_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    v_center uuid;
    v_title text;
    v_start timestamptz;
    v_account uuid;
    v_who text;
    m record;
begin
    if new.status = old.status then
        return new;  -- 상태 안 바뀌면 무시
    end if;

    select c.center_id, c.title, c.start_time into v_center, v_title, v_start
      from classes c where c.id = new.class_id;
    select pr.account_id, coalesce(pr.nickname, pr.name, '회원')
      into v_account, v_who
      from profiles pr where pr.id = new.profile_id;

    if old.status = 'waitlisted' and new.status = 'confirmed' then
        if v_account is not null then
            perform push_notification(
                v_account, 'waitlist_promoted', '대기하던 수업이 확정됐어요',
                v_title || ' · ' || to_char(v_start at time zone 'Asia/Seoul', 'MM/DD HH24:MI'),
                v_center, '/my-reservations',
                jsonb_build_object('reservation_id', new.id)
            );
        end if;

    elsif new.status = 'cancelled' then
        if v_account is not null then
            perform push_notification(
                v_account, 'reservation_canceled', '예약이 취소됐어요',
                v_title || ' · ' || to_char(v_start at time zone 'Asia/Seoul', 'MM/DD HH24:MI'),
                v_center, '/my-reservations',
                jsonb_build_object('reservation_id', new.id)
            );
        end if;
        for m in
            select account_id from manager_centers
             where center_id = v_center and status = 'active'
        loop
            perform push_notification(
                m.account_id, 'reservation_canceled', '예약이 취소됐어요',
                v_who || '님 · ' || v_title || ' ' ||
                    to_char(v_start at time zone 'Asia/Seoul', 'MM/DD HH24:MI'),
                v_center, '/manager/classes',
                jsonb_build_object('reservation_id', new.id)
            );
        end loop;

    elsif new.status = 'no_show' then
        for m in
            select account_id from manager_centers
             where center_id = v_center and status = 'active'
        loop
            perform push_notification(
                m.account_id, 'no_show', '노쇼가 발생했어요',
                v_who || '님이 ' || v_title || ' 수업에 오지 않았어요',
                v_center, '/manager/classes',
                jsonb_build_object('reservation_id', new.id)
            );
        end loop;
    end if;

    return new;
end;
$$;

COMMIT;
