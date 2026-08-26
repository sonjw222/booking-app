-- ============================================================
-- fix_class_cancel_deadline_override.sql 롤백
-- 컬럼을 NOT NULL DEFAULT 0으로 되돌리고(백필된 NULL은 다시 0으로), 세 RPC의 우선순위를
-- 원래대로(운영설정이 항상 우선) 되돌린다. 로직만 원복 — 진짜 롤백을 원한다면 이 파일 실행 후
-- classes.cancel_deadline_min 값도 필요시 수동으로 재검토할 것(NULL→0 백필은 여기서 함께 함).
-- ============================================================

BEGIN;

update classes set cancel_deadline_min = 0 where cancel_deadline_min is null;

alter table classes
    alter column cancel_deadline_min set default 0,
    alter column cancel_deadline_min set not null;

comment on column classes.cancel_deadline_min is '취소 마감';

create or replace function cancel_reservation(p_reservation_id uuid)
returns json
language plpgsql
security definer
as $$
declare
    v_res         record;
    v_class       record;
    v_next        record;
    v_next_mem    record;
    v_promoted    boolean := false;
    v_skip_refund boolean := false;
begin
    select * into v_res from reservations
    where id = p_reservation_id
      and profile_id in (select id from profiles where account_id = my_account_id())
    for update;

    if not found then
        raise exception '예약을 찾을 수 없어요';
    end if;
    if v_res.status = 'cancelled' then
        raise exception '이미 취소된 예약이에요';
    end if;

    select * into v_class from classes where id = v_res.class_id;
    if found then
        if now() >= v_class.start_time then
            raise exception '수업이 이미 시작되어 취소할 수 없어요';
        end if;

        declare
            v_cancel_deadline    timestamptz;
            v_deduct_late        boolean := false;
            v_is_late            boolean := false;
            v_grace_deadline     timestamptz;
            v_effective_deadline timestamptz;
        begin
            v_cancel_deadline := calc_deadline(v_class.center_id, v_class.class_format, v_class.start_time, 'cancel');
            if v_cancel_deadline is null then
                v_cancel_deadline := v_class.start_time - make_interval(mins => v_class.cancel_deadline_min);
            end if;

            v_grace_deadline := least(v_res.created_at + interval '10 minutes', v_class.start_time);
            v_effective_deadline := greatest(v_cancel_deadline, v_grace_deadline);

            v_is_late := now() > v_effective_deadline;

            select coalesce(deduct_on_late_cancel, false) into v_deduct_late
            from center_settings where center_id = v_class.center_id;

            if v_is_late and not v_deduct_late then
                raise exception '취소 마감시간이 지났어요';
            end if;
            v_skip_refund := v_is_late and v_deduct_late;
        end;
    end if;

    update reservations set status = 'cancelled', cancel_source = 'MEMBER' where id = p_reservation_id;

    if v_res.status = 'confirmed' then
        if not v_skip_refund then
            update memberships set remaining_count = remaining_count + 1
            where id = v_res.membership_id;
        end if;

        for v_next in
            select * from reservations
            where class_id = v_res.class_id and status = 'waitlisted'
            order by waitlist_order asc
            for update
        loop
            select * into v_next_mem from memberships
            where id = v_next.membership_id
              and remaining_count > 0
              and expires_at >= current_date
            for update;

            if found then
                update reservations
                set status = 'confirmed', waitlist_order = null
                where id = v_next.id;

                update memberships set remaining_count = remaining_count - 1
                where id = v_next_mem.id;

                v_promoted := true;
                exit;
            end if;
        end loop;
    end if;

    return json_build_object('cancelled', true, 'waitlist_promoted', v_promoted);
end;
$$;

create or replace function create_class_safe(
    p_center_id uuid, p_title text, p_description text,
    p_start_time timestamptz, p_end_time timestamptz, p_capacity int,
    p_allow_goods boolean, p_room_id uuid, p_cancel_deadline_min int,
    p_booking_deadline_min int, p_class_format text, p_pass_selection_mode text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
    v_id uuid;
    v_key text;
begin
    v_key := 'schedule.own.' || (case when p_class_format = 'private' then 'private' else 'group' end) || '.create';
    if not (has_permission(p_center_id, v_key) or is_platform_admin()) then
        raise exception '이 센터에 수업을 등록할 권한이 없어요';
    end if;

    insert into classes (
        center_id, title, description, start_time, end_time, capacity,
        allow_goods, room_id, cancel_deadline_min, booking_deadline_min,
        class_format, pass_selection_mode
    ) values (
        p_center_id, p_title, p_description, p_start_time, p_end_time, p_capacity,
        coalesce(p_allow_goods, true), p_room_id, coalesce(p_cancel_deadline_min, 0), p_booking_deadline_min,
        coalesce(p_class_format, 'group'), coalesce(p_pass_selection_mode, 'all')
    ) returning id into v_id;

    return v_id;
end;
$$;

create or replace function create_recurring_classes_safe(p_center_id uuid, p_rows jsonb)
returns uuid[]
language plpgsql
security definer
set search_path = public
as $$
declare
    v_ids uuid[];
begin
    if not (has_permission(p_center_id, 'schedule.own.group.create') or is_platform_admin()) then
        raise exception '이 센터에 수업을 등록할 권한이 없어요';
    end if;

    with inserted as (
        insert into classes (
            center_id, title, start_time, end_time, capacity, room_id,
            cancel_deadline_min, booking_deadline_min, recurring_group_id,
            pass_selection_mode, allow_goods, status
        )
        select
            p_center_id,
            r->>'title',
            (r->>'start_time')::timestamptz,
            (r->>'end_time')::timestamptz,
            (r->>'capacity')::int,
            nullif(r->>'room_id', '')::uuid,
            coalesce((r->>'cancel_deadline_min')::int, 0),
            nullif(r->>'booking_deadline_min', '')::int,
            nullif(r->>'recurring_group_id', '')::uuid,
            coalesce(r->>'pass_selection_mode', 'all'),
            coalesce((r->>'allow_goods')::boolean, true),
            'open'
        from jsonb_array_elements(p_rows) as r
        returning id
    )
    select array_agg(id) into v_ids from inserted;

    return coalesce(v_ids, array[]::uuid[]);
end;
$$;

create or replace function update_class_safe(
    p_class_id uuid, p_title text, p_description text,
    p_start_time timestamptz, p_end_time timestamptz, p_capacity int,
    p_allow_goods boolean, p_room_id uuid, p_cancel_deadline_min int,
    p_booking_deadline_min int, p_class_format text, p_pass_selection_mode text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    v_center_id uuid;
    v_format text;
    v_is_own boolean;
    v_key text;
begin
    select center_id, class_format into v_center_id, v_format from classes where id = p_class_id;
    if v_center_id is null then
        raise exception '수업을 찾을 수 없어요';
    end if;

    v_is_own := not exists (select 1 from class_trainers where class_id = p_class_id)
             or exists (select 1 from class_trainers where class_id = p_class_id and account_id = my_account_id());
    v_key := 'schedule.' || (case when v_is_own then 'own' else 'other' end) || '.' ||
             (case when v_format = 'private' then 'private' else 'group' end) || '.update';
    if not (has_permission(v_center_id, v_key) or is_platform_admin()) then
        raise exception '이 수업을 수정할 권한이 없어요';
    end if;

    update classes set
        title = p_title,
        description = p_description,
        start_time = p_start_time,
        end_time = p_end_time,
        capacity = p_capacity,
        allow_goods = coalesce(p_allow_goods, true),
        room_id = p_room_id,
        cancel_deadline_min = coalesce(p_cancel_deadline_min, 0),
        booking_deadline_min = p_booking_deadline_min,
        class_format = coalesce(p_class_format, 'group'),
        pass_selection_mode = coalesce(p_pass_selection_mode, 'all')
    where id = p_class_id;
end;
$$;

COMMIT;
