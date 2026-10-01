-- ============================================================
-- fix_recurring_class_description_and_group_update.sql 롤백 — 적용 직전 라이브 정의(2026-10-01)로 복원.
-- 이미 저장된 description 값은 지우지 않는다(함수 정의만 되돌림).
-- ============================================================
CREATE OR REPLACE FUNCTION public.create_recurring_classes_safe(p_center_id uuid, p_rows jsonb, p_is_copy boolean DEFAULT false)
 RETURNS uuid[]
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_ids uuid[];
begin
    if not (has_permission(p_center_id, 'schedule.own.group.create') or is_platform_admin()) then
        raise exception '이 센터에 수업을 등록할 권한이 없어요';
    end if;
    if p_is_copy and not (has_permission(p_center_id, 'schedule.copy') or is_platform_admin()) then
        raise exception '일정을 복사할 권한이 없어요';
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
$function$;


CREATE OR REPLACE FUNCTION public.update_class_group_safe(p_group_id uuid, p_title text, p_capacity integer, p_updates jsonb)
 RETURNS uuid[]
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_center_id uuid;
    v_is_own boolean;
    v_is_past boolean;
    v_key text;
    v_verb text;
    v_ids uuid[];
begin
    select center_id into v_center_id from classes where recurring_group_id = p_group_id limit 1;
    if v_center_id is null then
        raise exception '수업을 찾을 수 없어요';
    end if;

    v_is_own := not exists (
            select 1 from class_trainers ct join classes c on c.id = ct.class_id
             where c.recurring_group_id = p_group_id
        )
        or exists (
            select 1 from class_trainers ct join classes c on c.id = ct.class_id
             where c.recurring_group_id = p_group_id and ct.account_id = my_account_id()
        );
    v_is_past := exists (
        select 1 from classes c, jsonb_array_elements(p_updates) as u
        where c.id = (u->>'id')::uuid and c.recurring_group_id = p_group_id and c.start_time < now()
    );
    v_verb := case when v_is_past then 'past_update' else 'update' end;
    -- 반복 등록은 group 수업만 지원(create_recurring_classes_safe와 동일한 전제)
    v_key := 'schedule.' || (case when v_is_own then 'own' else 'other' end) || '.group.' || v_verb;
    if not (has_permission(v_center_id, v_key) or is_platform_admin()) then
        raise exception '이 수업을 수정할 권한이 없어요';
    end if;

    with upd as (
        update classes c set
            title = p_title,
            capacity = p_capacity,
            start_time = (u->>'start_time')::timestamptz,
            end_time = (u->>'end_time')::timestamptz
        from jsonb_array_elements(p_updates) as u
        where c.id = (u->>'id')::uuid and c.recurring_group_id = p_group_id
        returning c.id
    )
    select array_agg(id) into v_ids from upd;

    return coalesce(v_ids, array[]::uuid[]);
end;
$function$;
