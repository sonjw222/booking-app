-- ============================================================
-- fix_manager_product_class_ux_20261002.sql 롤백 — 적용 전 라이브 정의로 정확히 복원.
-- ⚠ 롤백하면 (1) 요일 선택형 수강권을 선택 없이 주문해도 서버가 막지 않고, (2) 반복 수업 전체 적용이 수강권 설정을 반영하지 않고(키를 무시),
--   (3) 담당 강사 저장 순서가 더 이상 sort_order로 보장되지 않는다(이미 저장된 sort_order 값/컬럼은 보존 — 컬럼 삭제는 아래 주석을 직접 풀어야 한다).
--   롤백 후 setter는 sort_order를 기본값 0으로 저장하고 class_trainer_names는 순서를 보장하지 않는다.
-- ============================================================
BEGIN;

drop trigger if exists orders_require_schedule_selection on orders;
drop function if exists orders_require_schedule_selection();

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
    v_row jsonb;
    v_confirmed int;
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

    -- 선택 항목 검증: 룸은 같은 센터 것만, 정원은 현재 확정 인원 아래로 줄일 수 없다(update_class_safe와 동일한 불변식).
    for v_row in select u from jsonb_array_elements(p_updates) u loop
        if v_row ? 'room_id' and nullif(v_row->>'room_id', '') is not null
           and not exists (select 1 from rooms r where r.id = (v_row->>'room_id')::uuid and r.center_id = v_center_id) then
            raise exception '이 센터의 룸이 아니에요';
        end if;
        if v_row ? 'capacity' then
            select count(*) into v_confirmed from reservations
             where class_id = (v_row->>'id')::uuid and status in ('confirmed', 'attended');
            if (v_row->>'capacity')::int < v_confirmed then
                raise exception '현재 확정 예약 인원(%명)보다 적게 정원을 줄일 수 없어요', v_confirmed;
            end if;
        end if;
    end loop;

    -- 같은 center_id + 같은 recurring_group_id의 수업만, 한 문장(=한 트랜잭션)으로 갱신한다.
    -- p_updates 각 행은 id/start_time/end_time(각 수업의 기존 값 또는 의도된 값)과, "바뀐 공통 필드만" 선택 키로 온다:
    --   description, capacity, room_id, allow_goods, allow_cancel, cancel_deadline_min, booking_deadline_min
    -- 키가 없으면 그 수업의 기존 값을 유지한다(요일마다 다른 정원/룸/마감 설정을 덮어쓰지 않음).
    -- p_capacity는 하위 호환용으로만 남겼고 더 이상 그룹 전체에 강제하지 않는다(행의 'capacity' 키가 대신한다).
    with upd as (
        update classes c set
            title = p_title,
            start_time = (u->>'start_time')::timestamptz,
            end_time = (u->>'end_time')::timestamptz,
            capacity = case when u ? 'capacity' then (u->>'capacity')::int else c.capacity end,
            description = case when u ? 'description' then nullif(btrim(coalesce(u->>'description', '')), '') else c.description end,
            room_id = case when u ? 'room_id' then nullif(u->>'room_id', '')::uuid else c.room_id end,
            allow_goods = case when u ? 'allow_goods' then (u->>'allow_goods')::boolean else c.allow_goods end,
            allow_cancel = case when u ? 'allow_cancel' then (u->>'allow_cancel')::boolean else c.allow_cancel end,
            cancel_deadline_min = case when u ? 'cancel_deadline_min' then nullif(u->>'cancel_deadline_min', '')::int else c.cancel_deadline_min end,
            booking_deadline_min = case when u ? 'booking_deadline_min' then nullif(u->>'booking_deadline_min', '')::int else c.booking_deadline_min end
        from jsonb_array_elements(p_updates) as u
        where c.id = (u->>'id')::uuid
          and c.recurring_group_id = p_group_id
          and c.center_id = v_center_id
        returning c.id
    )
    select array_agg(id) into v_ids from upd;

    return coalesce(v_ids, array[]::uuid[]);
end;
$function$;

grant execute on function update_class_group_safe(uuid, text, integer, jsonb) to anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.set_class_trainers_safe(p_class_id uuid, p_account_ids uuid[])
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
        raise exception '담당 강사를 지정할 권한이 없어요';
    end if;

    delete from class_trainers where class_id = p_class_id;
    if p_account_ids is not null and array_length(p_account_ids, 1) > 0 then
        insert into class_trainers (class_id, account_id)
        select p_class_id, aid from unnest(p_account_ids) as aid;
    end if;
end;
$function$;

grant execute on function set_class_trainers_safe(uuid, uuid[]) to anon, authenticated, service_role;
CREATE OR REPLACE FUNCTION public.set_class_trainers_bulk_safe(p_class_ids uuid[], p_account_ids uuid[])
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_center_id uuid;
begin
    if p_class_ids is null or array_length(p_class_ids, 1) is null then
        return;
    end if;

    select center_id into v_center_id from classes where id = p_class_ids[1];
    if v_center_id is null then
        raise exception '수업을 찾을 수 없어요';
    end if;
    if not (has_permission(v_center_id, 'schedule.own.group.create') or is_platform_admin()) then
        raise exception '담당 강사를 지정할 권한이 없어요';
    end if;

    if p_account_ids is not null and array_length(p_account_ids, 1) > 0 then
        insert into class_trainers (class_id, account_id)
        select cid, aid from unnest(p_class_ids) as cid, unnest(p_account_ids) as aid;
    end if;
end;
$function$;

grant execute on function set_class_trainers_bulk_safe(uuid[], uuid[]) to anon, authenticated, service_role;
CREATE OR REPLACE FUNCTION public.set_class_trainers_for_group_safe(p_class_ids uuid[], p_account_ids uuid[])
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_center_id uuid;
    v_is_own boolean;
    v_key text;
begin
    if p_class_ids is null or array_length(p_class_ids, 1) is null then
        return;
    end if;

    select center_id into v_center_id from classes where id = p_class_ids[1];
    if v_center_id is null then
        raise exception '수업을 찾을 수 없어요';
    end if;

    v_is_own := not exists (select 1 from class_trainers where class_id = any(p_class_ids))
             or exists (select 1 from class_trainers where class_id = any(p_class_ids) and account_id = my_account_id());
    v_key := 'schedule.' || (case when v_is_own then 'own' else 'other' end) || '.group.update';
    if not (has_permission(v_center_id, v_key) or is_platform_admin()) then
        raise exception '담당 강사를 지정할 권한이 없어요';
    end if;

    delete from class_trainers where class_id = any(p_class_ids);
    if p_account_ids is not null and array_length(p_account_ids, 1) > 0 then
        insert into class_trainers (class_id, account_id)
        select cid, aid from unnest(p_class_ids) as cid, unnest(p_account_ids) as aid;
    end if;
end;
$function$;

grant execute on function set_class_trainers_for_group_safe(uuid[], uuid[]) to anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.class_trainer_names(p_class_ids uuid[])
 RETURNS TABLE(class_id uuid, account_id uuid, name text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
    select ct.class_id, ct.account_id, a.name
    from class_trainers ct
    join accounts a on a.id = ct.account_id
    where ct.class_id = any(p_class_ids)
      and auth.uid() is not null;
$function$;


drop index if exists idx_class_trainers_class_order;
-- alter table class_trainers drop column if exists sort_order;

COMMIT;
