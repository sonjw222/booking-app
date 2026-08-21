-- rollback: fix_permission_classes_own_other.sql
-- 새로 만든 RPC들을 삭제하고, delete_class_safe/delete_class_group_safe만 own/other
-- 구분 이전(schedule.own.group.delete 하드코딩)으로 되돌린다.
-- ⚠ lib/classes.ts가 이 RPC들을 호출하도록 이미 바뀌었다면, 이 롤백만 실행해서는 앱이
--   깨진다 — 코드도 함께 이전 커밋으로 되돌려야 한다.

drop function if exists create_class_safe(uuid, text, text, timestamptz, timestamptz, int, boolean, uuid, int, int, text, text);
drop function if exists create_recurring_classes_safe(uuid, jsonb);
drop function if exists update_class_safe(uuid, text, text, timestamptz, timestamptz, int, boolean, uuid, int, int, text, text);
drop function if exists update_class_pass_selection_mode_safe(uuid, text);
drop function if exists update_class_group_safe(uuid, text, int, jsonb);
drop function if exists set_class_trainers_safe(uuid, uuid[]);
drop function if exists set_class_trainers_bulk_safe(uuid[], uuid[]);
drop function if exists set_class_trainers_for_group_safe(uuid[], uuid[]);

create or replace function delete_class_safe(p_class_id uuid)
returns json
language plpgsql
security definer
as $$
declare
    v_center_id uuid;
    v_title     text;
    v_active    int;
begin
    select center_id, title into v_center_id, v_title
    from classes where id = p_class_id;
    if not found then
        raise exception '수업을 찾을 수 없어요';
    end if;

    if not has_permission(v_center_id, 'schedule.own.group.delete') and not is_platform_admin() then
        raise exception '이 수업을 삭제할 권한이 없어요';
    end if;

    select count(*) into v_active from reservations
    where class_id = p_class_id and status in ('confirmed','waitlisted','attended');
    if v_active > 0 then
        raise exception '확정·대기·출석 예약이 있어 삭제할 수 없어요 (%건). 먼저 처리해주세요', v_active;
    end if;

    delete from reservations where class_id = p_class_id;
    delete from classes where id = p_class_id;

    if not exists (select 1 from classes where center_id = v_center_id and title = v_title) then
        delete from membership_schedule_rules
        where class_title = v_title
          and product_id in (select id from products where center_id = v_center_id);
    end if;

    return json_build_object('deleted', true);
end;
$$;

create or replace function delete_class_group_safe(p_group_id uuid)
returns json
language plpgsql
security definer
as $$
declare
    v_center_id uuid;
    v_title     text;
    v_active    int;
begin
    select center_id, title into v_center_id, v_title
    from classes where recurring_group_id = p_group_id limit 1;
    if not found then
        raise exception '수업을 찾을 수 없어요';
    end if;

    if not has_permission(v_center_id, 'schedule.own.group.delete') and not is_platform_admin() then
        raise exception '이 수업을 삭제할 권한이 없어요';
    end if;

    select count(*) into v_active from reservations
    where class_id in (select id from classes where recurring_group_id = p_group_id)
      and status in ('confirmed','waitlisted','attended');
    if v_active > 0 then
        raise exception '확정·대기·출석 예약이 있어 삭제할 수 없어요 (%건). 먼저 처리해주세요', v_active;
    end if;

    delete from reservations
    where class_id in (select id from classes where recurring_group_id = p_group_id);
    delete from classes where recurring_group_id = p_group_id;

    if not exists (select 1 from classes where center_id = v_center_id and title = v_title) then
        delete from membership_schedule_rules
        where class_title = v_title
          and product_id in (select id from products where center_id = v_center_id);
    end if;

    return json_build_object('deleted', true);
end;
$$;
