-- ============================================================
-- P2-31 — 일정(schedule) 세분권한 완성 배치
--
-- 배경: fix_permission_classes_own_other.sql(P1-5b, 이미 라이브 적용됨)이 own/other ×
-- group/private의 create/update/delete는 이미 연결했다. 2026-09-09 전수 재조사로
-- 실제로 남은 갭은 딱 두 종류였다(사용자 승인, "완성" 방향):
--   (a) 예약변경/취소 8개 — manager_set_attendance()가 schedule.attendance 하나로만
--       뭉쳐서 체크하고 있어서, 예약을 확정(booking)/취소(cancel)하는 것도 출결 처리와
--       똑같이 취급됐다. 출석/결석/노쇼는 schedule.attendance 그대로 유지하고,
--       확정(confirmed)/취소(cancelled) 전이만 own/other × group/private로 쪼갠다.
--   (b) 과거수업 20개 — "이 수업이 이미 시작됐는지"를 보는 로직이 지금까지 아예 없어서
--       미래든 과거든 똑같이 취급됐다. classes/attendance 관련 함수들에 start_time < now()
--       분기를 추가해 과거 수업엔 past_ 접두사가 붙은 키를 요구하게 한다.
--
-- 그 외 카탈로그 정리(사용자 승인):
--   - schedule.other.group.create / schedule.other.private.create 삭제 — 생성 시점엔
--     아직 강사가 배정되지 않아 own/other 구분이 성립하지 않는 설계상 불가능한 키.
--     삭제해도 강사 배정 자체(set_class_trainers_safe 등)는 완전히 별개 동작이라 영향 없음.
--   - schedule.copy — 지금은 create_recurring_classes_safe가 schedule.own.group.create
--     하나로만 통제돼 "일정 복사"만 따로 막을 방법이 없었다. p_is_copy 플래그를 추가해
--     복사 경로(lib/classes.ts의 insertCopiedClasses)에서만 schedule.copy를 추가로 요구한다.
--     반복 등록 경로(createRecurringClasses/createRecurringClassesPerDay)는 그대로 create
--     권한 하나로 충분 — 이 두 경로는 p_is_copy를 안 넘기므로(기본값 false) 영향 없음.
--
-- 범위 밖(별도 사안, 이번 배치 안 건드림): schedule.own.etc.*/schedule.memo.*는
-- staff_schedules/schedule_memos 화면 자체가 아직 없어 P3-5로 이미 별도 관리 중.
-- schedule.memo.*는 add_schedule_memo_feature.sql에서 별도로 다룬다.
--
-- ⚠ 동작 변경 주의: 이 8+20개 키를 아직 역할에 안 준 기존 스태프는 (b)의 경우 과거 수업
--   수정/삭제/예약처리, (a)의 경우 예약 확정/취소를 더 이상 못 하게 될 수 있다.
--   오너는 항상 전권이라 영향 없음(is_platform_admin 포함).
--
-- 파일 전체를 SQL Editor에 붙여넣고 Run 하세요. 여러 번 실행해도 안전.
-- ============================================================

-- ------------------------------------------------------------
-- [0] 카탈로그 정리 — 설계상 불가능한 create 키 2개 삭제
-- ------------------------------------------------------------
delete from role_permissions where permission_key in ('schedule.other.group.create', 'schedule.other.private.create');
delete from permissions where key in ('schedule.other.group.create', 'schedule.other.private.create');

-- ------------------------------------------------------------
-- [1] 수업 생성 (단발) — past_create 추가
-- ------------------------------------------------------------
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
    v_verb text;
begin
    v_verb := case when p_start_time < now() then 'past_create' else 'create' end;
    v_key := 'schedule.own.' || (case when p_class_format = 'private' then 'private' else 'group' end) || '.' || v_verb;
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

-- ------------------------------------------------------------
-- [2] 수업 생성 (반복 등록 + 스케줄 복사 공용) — p_is_copy 플래그 추가.
-- past_* 분기는 안 건다(반복/복사 생성은 항상 미래 날짜라는 전제, 기존과 동일).
-- ------------------------------------------------------------
create or replace function create_recurring_classes_safe(p_center_id uuid, p_rows jsonb, p_is_copy boolean default false)
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
$$;

-- ------------------------------------------------------------
-- [3] 수업 수정 (단발) — past_update 추가 (기존 저장된 start_time 기준으로 판정)
-- ------------------------------------------------------------
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
    v_orig_start timestamptz;
    v_is_own boolean;
    v_key text;
    v_verb text;
begin
    select center_id, class_format, start_time into v_center_id, v_format, v_orig_start from classes where id = p_class_id;
    if v_center_id is null then
        raise exception '수업을 찾을 수 없어요';
    end if;

    v_is_own := not exists (select 1 from class_trainers where class_id = p_class_id)
             or exists (select 1 from class_trainers where class_id = p_class_id and account_id = my_account_id());
    v_verb := case when v_orig_start < now() then 'past_update' else 'update' end;
    v_key := 'schedule.' || (case when v_is_own then 'own' else 'other' end) || '.' ||
             (case when v_format = 'private' then 'private' else 'group' end) || '.' || v_verb;
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

-- 그룹 일괄 수정에서, 이 인스턴스의 pass_selection_mode만 별도로 맞추는 용도 — past_update 추가
create or replace function update_class_pass_selection_mode_safe(p_class_id uuid, p_mode text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    v_center_id uuid;
    v_format text;
    v_orig_start timestamptz;
    v_is_own boolean;
    v_key text;
    v_verb text;
begin
    select center_id, class_format, start_time into v_center_id, v_format, v_orig_start from classes where id = p_class_id;
    if v_center_id is null then
        raise exception '수업을 찾을 수 없어요';
    end if;

    v_is_own := not exists (select 1 from class_trainers where class_id = p_class_id)
             or exists (select 1 from class_trainers where class_id = p_class_id and account_id = my_account_id());
    v_verb := case when v_orig_start < now() then 'past_update' else 'update' end;
    v_key := 'schedule.' || (case when v_is_own then 'own' else 'other' end) || '.' ||
             (case when v_format = 'private' then 'private' else 'group' end) || '.' || v_verb;
    if not (has_permission(v_center_id, v_key) or is_platform_admin()) then
        raise exception '이 수업을 수정할 권한이 없어요';
    end if;

    update classes set pass_selection_mode = p_mode where id = p_class_id;
end;
$$;

-- ------------------------------------------------------------
-- [4] 반복 그룹 일괄 수정 — past_update 추가 (수정 대상 인스턴스 중 하나라도
-- 이미 시작됐으면 past_update 요구)
-- ------------------------------------------------------------
create or replace function update_class_group_safe(p_group_id uuid, p_title text, p_capacity int, p_updates jsonb)
returns uuid[]
language plpgsql
security definer
set search_path = public
as $$
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
$$;

-- ------------------------------------------------------------
-- [5] 삭제 — past_delete 추가
-- ------------------------------------------------------------
create or replace function delete_class_safe(p_class_id uuid)
returns json
language plpgsql
security definer
as $$
declare
    v_center_id uuid;
    v_format    text;
    v_title     text;
    v_start     timestamptz;
    v_active    int;
    v_is_own    boolean;
    v_key       text;
    v_verb      text;
begin
    select center_id, class_format, title, start_time into v_center_id, v_format, v_title, v_start
    from classes where id = p_class_id;
    if not found then
        raise exception '수업을 찾을 수 없어요';
    end if;

    v_is_own := not exists (select 1 from class_trainers where class_id = p_class_id)
             or exists (select 1 from class_trainers where class_id = p_class_id and account_id = my_account_id());
    v_verb := case when v_start < now() then 'past_delete' else 'delete' end;
    v_key := 'schedule.' || (case when v_is_own then 'own' else 'other' end) || '.' ||
             (case when v_format = 'private' then 'private' else 'group' end) || '.' || v_verb;
    if not has_permission(v_center_id, v_key) and not is_platform_admin() then
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
    v_format    text;
    v_title     text;
    v_active    int;
    v_is_own    boolean;
    v_is_past   boolean;
    v_key       text;
    v_verb      text;
begin
    select center_id, class_format, title into v_center_id, v_format, v_title
    from classes where recurring_group_id = p_group_id limit 1;
    if not found then
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
    v_is_past := exists (select 1 from classes where recurring_group_id = p_group_id and start_time < now());
    v_verb := case when v_is_past then 'past_delete' else 'delete' end;
    v_key := 'schedule.' || (case when v_is_own then 'own' else 'other' end) || '.' ||
             (case when v_format = 'private' then 'private' else 'group' end) || '.' || v_verb;
    if not has_permission(v_center_id, v_key) and not is_platform_admin() then
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

-- ------------------------------------------------------------
-- [6] 출결 처리 — 확정(booking)/취소(cancel)를 own/other × group/private × past로 분리.
-- 출석/결석/노쇼는 schedule.attendance 그대로 유지(변경 없음).
-- ------------------------------------------------------------
create or replace function manager_set_attendance(p_reservation_id uuid, p_status text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
    v_res      record;
    v_class    record;
    v_restored boolean := false;
    v_admin_id uuid;
    v_is_own   boolean;
    v_format   text;
    v_verb     text;
    v_key      text;
begin
    if p_status not in ('attended', 'no_show', 'confirmed', 'cancelled') then
        raise exception '잘못된 상태예요';
    end if;

    select * into v_res from reservations where id = p_reservation_id for update;
    if not found then
        raise exception '예약을 찾을 수 없어요';
    end if;

    select * into v_class from classes where id = v_res.class_id;
    if not found then
        raise exception '수업을 찾을 수 없어요';
    end if;

    if p_status in ('attended', 'no_show') then
        if not (has_permission(v_class.center_id, 'schedule.attendance') or is_platform_admin()) then
            raise exception '이 예약을 처리할 권한이 없어요';
        end if;
    else
        v_is_own := not exists (select 1 from class_trainers where class_id = v_class.id)
                 or exists (select 1 from class_trainers where class_id = v_class.id and account_id = my_account_id());
        v_format := case when v_class.class_format = 'private' then 'private' else 'group' end;
        v_verb := case when p_status = 'confirmed' then 'booking' else 'cancel' end;
        if v_class.start_time < now() then
            v_verb := 'past_' || v_verb;
        end if;
        v_key := 'schedule.' || (case when v_is_own then 'own' else 'other' end) || '.' || v_format || '.' || v_verb;
        if not (has_permission(v_class.center_id, v_key) or is_platform_admin()) then
            raise exception '이 예약을 처리할 권한이 없어요';
        end if;
    end if;

    if v_res.status = 'cancelled' then
        raise exception '이미 취소된 예약이라 출결 상태를 바꿀 수 없어요';
    end if;

    if v_res.status = 'waitlisted' and p_status in ('attended', 'no_show') then
        raise exception '대기 중인 예약은 출석/결석으로 표시할 수 없어요 — 먼저 확정돼야 해요';
    end if;

    if v_res.status = 'waitlisted' and p_status = 'confirmed' then
        raise exception '대기 예약은 이 화면에서 바로 확정으로 바꿀 수 없어요 — 정원이 비면 자동으로 승격돼요';
    end if;

    v_admin_id := my_account_id();

    if p_status = 'cancelled' then
        if v_res.status in ('confirmed', 'attended', 'no_show') and v_res.membership_id is not null then
            update memberships
               set remaining_count = remaining_count + 1
             where id = v_res.membership_id
               and remaining_count is not null;
            v_restored := true;
        end if;

        update reservations
           set status = p_status,
               cancelled_by = v_admin_id,
               cancelled_at = now(),
               updated_at = now()
         where id = p_reservation_id;
    else
        update reservations
           set status = p_status, updated_at = now()
         where id = p_reservation_id;
    end if;

    return json_build_object('status', p_status, 'restored', v_restored);
end;
$$;

-- ============================================================
-- 확인
-- ============================================================
select key from permissions where key in ('schedule.other.group.create', 'schedule.other.private.create'); -- 0행이어야 정상
select proname, pg_get_function_arguments(oid) as args from pg_proc
where proname in (
    'create_class_safe', 'create_recurring_classes_safe',
    'update_class_safe', 'update_class_pass_selection_mode_safe', 'update_class_group_safe',
    'delete_class_safe', 'delete_class_group_safe', 'manager_set_attendance'
) order by proname;
