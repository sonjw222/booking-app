-- ============================================================
-- P1-5b (Bucket 2) — classes/class_trainers 진짜 own/other 세분권한
--
-- 배경: 수업 생성/수정(직접 insert/update, RPC 아님)과 담당 강사 배정
--   (class_trainers, 역시 직접 insert/update/delete)이 my_managed_center_ids()만
--   체크했다(P1-5 4차 조사 + 라이브 정의 확인). 삭제(delete_class_safe/
--   delete_class_group_safe)는 이미 RPC였지만 group/private·own/other 구분 없이
--   무조건 schedule.own.group.delete 하나만 체크했다.
--
-- 설계(사용자 승인, 2026-08-21):
--   - "own" 판정: 그 수업(또는 그룹)의 class_trainers에 내 계정이 있으면 own, 다른
--     사람만 있으면 other. 담당 강사가 아예 없으면 own으로 간주(임자 없는 수업은
--     own 권한자가 챙길 수 있어야 함).
--   - "생성"은 아직 강사가 배정되지 않은 새 수업이라 other 개념이 성립하지 않음 →
--     schedule.own.{group|private}.create 하나만 요구.
--   - class_format(group/private)에 따라 키의 두 번째 세그먼트가 갈림.
--   - 담당 강사 재배정(class_trainers)도 "그 수업을 고치는 행위"로 보고 .update 키를
--     재사용 — 별도의 "강사배정" 키가 카탈로그에 없음.
--
-- 구조 변경: classes/class_trainers를 클라이언트가 직접 insert/update하던 경로를
--   전부 새 RPC로 옮긴다(create_class_safe, create_recurring_classes_safe,
--   update_class_safe, update_class_group_safe, update_class_pass_selection_mode_safe,
--   set_class_trainers_safe, set_class_trainers_bulk_safe, set_class_trainers_for_group_safe).
--   RLS만으로는 "이 요청이 어떤 강사를 배정하려는지"를 알 수 없어(별도 insert로 옴)
--   own/other를 실제로 판정하려면 서버 함수 안에서 확인해야 한다. lib/classes.ts의
--   해당 함수들은 시그니처를 그대로 유지한 채 내부 구현만 RPC 호출로 바뀐다 —
--   app/manager/classes/page.tsx 등 호출부는 수정할 필요 없음.
--
-- ⚠ 범위 밖: 예약 배치/취소(schedule.makeup, Bucket 1에서 이미 처리)는 건드리지 않음.
--   classes/class_trainers 테이블 자체의 RLS(직접 insert/update)는 이번에 강화하지
--   않는다 — my_managed_center_ids()로 넓게 열려 있지만, 실제 앱 클라이언트는 이제
--   전부 이 RPC들을 거쳐가므로(직접 테이블 호출 경로가 lib/classes.ts에서 모두
--   제거됨) 사실상의 방어선은 이 RPC들이다. orders/fulfill_order가 이미 이 저장소에서
--   쓰고 있는 것과 같은 패턴(테이블 RLS는 넓고 RPC가 실질적 방어선).
--
-- ⚠ 동작 변경 주의: 이 권한들을 아직 역할에 안 준 기존 스태프는 수업 생성/수정/삭제,
--   담당 강사 재배정을 더 이상 못 하게 된다(자기 담당 수업이라도 own 키가 없으면 막힘).
--   오너는 항상 전권이라 영향 없음. 카탈로그의 own/other × group/private 키 8개
--   (schedule.own.group.create/update/delete, schedule.own.private.create/update/delete,
--   schedule.other.group.update/delete, schedule.other.private.update/delete)를 실제로
--   쓰게 되는 첫 배치 — 기존 센터가 스태프에게 이 키들을 미리 부여해두지 않았다면
--   전부 오너만 수업을 만들고 고칠 수 있는 상태로 바뀐다는 뜻이다.
--
-- 파일 전체를 SQL Editor에 붙여넣고 Run 하세요. 여러 번 실행해도 안전.
-- ============================================================

-- ------------------------------------------------------------
-- 수업 생성 (단발)
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

-- ------------------------------------------------------------
-- 수업 생성 (반복 등록 + 스케줄 복사 공용) — 여러 행을 한 번에.
-- p_rows: [{title, start_time, end_time, capacity, room_id, cancel_deadline_min,
--           booking_deadline_min, recurring_group_id, pass_selection_mode, allow_goods}, ...]
-- 반복/복사 모두 그룹(group) 수업만 지원한다(프라이빗 반복 생성 UI 없음).
-- ------------------------------------------------------------
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

-- ------------------------------------------------------------
-- 수업 수정 (단발) — own/other는 기존 class_trainers 기준으로 판정
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

-- 그룹 일괄 수정에서, 이 인스턴스의 pass_selection_mode만 별도로 맞추는 용도
-- (updateClassGroup은 title/시간/정원만 그룹 전체에 반영하고 이 컬럼은 안 건드림)
create or replace function update_class_pass_selection_mode_safe(p_class_id uuid, p_mode text)
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

    update classes set pass_selection_mode = p_mode where id = p_class_id;
end;
$$;

-- ------------------------------------------------------------
-- 반복 그룹 일괄 수정 (title/시간/정원, 날짜는 각 인스턴스 유지)
-- p_updates: [{id, start_time, end_time}, ...] — 각 인스턴스별 새 시각(클라이언트가
-- 기존 날짜에 새 시:분만 적용해 계산). own/other는 그룹 내 어느 수업에든 배정된
-- class_trainers 기준(그룹은 보통 같은 강사로 통일돼 있다는 전제).
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
    v_key text;
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
    -- 반복 등록은 group 수업만 지원(create_recurring_classes_safe와 동일한 전제)
    v_key := 'schedule.' || (case when v_is_own then 'own' else 'other' end) || '.group.update';
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
-- 담당 강사 배정 (단발 수업, 신규/기존 공용 — 신규면 기존 배정이 없어 자동 own)
-- ------------------------------------------------------------
create or replace function set_class_trainers_safe(p_class_id uuid, p_account_ids uuid[])
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
        raise exception '담당 강사를 지정할 권한이 없어요';
    end if;

    delete from class_trainers where class_id = p_class_id;
    if p_account_ids is not null and array_length(p_account_ids, 1) > 0 then
        insert into class_trainers (class_id, account_id)
        select p_class_id, aid from unnest(p_account_ids) as aid;
    end if;
end;
$$;

-- 여러 수업(반복 등록 직후, 전부 신규 → 항상 own)에 같은 강사 목록 지정.
-- 대표로 첫 번째 class의 center_id로 create 권한을 확인한다(반복 등록 한 배치는
-- 모두 같은 센터).
create or replace function set_class_trainers_bulk_safe(p_class_ids uuid[], p_account_ids uuid[])
returns void
language plpgsql
security definer
set search_path = public
as $$
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
$$;

-- 반복 그룹 "모든 수업에 적용" — 기존 수업들의 담당 강사를 통째로 교체(그룹 편집용)
create or replace function set_class_trainers_for_group_safe(p_class_ids uuid[], p_account_ids uuid[])
returns void
language plpgsql
security definer
set search_path = public
as $$
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
$$;

-- ------------------------------------------------------------
-- 삭제: 하드코딩된 schedule.own.group.delete를 own/other × group/private으로 교체
-- (나머지 로직은 라이브 정의와 동일 — pg_get_functiondef로 확인 완료)
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
    v_active    int;
    v_is_own    boolean;
    v_key       text;
begin
    select center_id, class_format, title into v_center_id, v_format, v_title
    from classes where id = p_class_id;
    if not found then
        raise exception '수업을 찾을 수 없어요';
    end if;

    v_is_own := not exists (select 1 from class_trainers where class_id = p_class_id)
             or exists (select 1 from class_trainers where class_id = p_class_id and account_id = my_account_id());
    v_key := 'schedule.' || (case when v_is_own then 'own' else 'other' end) || '.' ||
             (case when v_format = 'private' then 'private' else 'group' end) || '.delete';
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
    v_key       text;
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
    v_key := 'schedule.' || (case when v_is_own then 'own' else 'other' end) || '.' ||
             (case when v_format = 'private' then 'private' else 'group' end) || '.delete';
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

-- ============================================================
-- 확인
-- ============================================================
select proname from pg_proc where proname in (
    'create_class_safe', 'create_recurring_classes_safe',
    'update_class_safe', 'update_class_pass_selection_mode_safe', 'update_class_group_safe',
    'set_class_trainers_safe', 'set_class_trainers_bulk_safe', 'set_class_trainers_for_group_safe',
    'delete_class_safe', 'delete_class_group_safe'
) order by proname;
