-- ============================================================
-- 반복 수업: 수업 소개(description) 저장 + 그룹 수정 시 소개 반영 (2026-10-01 QA 7/10)
--
-- [QA 7 원인] create_recurring_classes_safe()의 INSERT 컬럼 목록에 description이 아예 없었다
--   (단일 수업용 create_class_safe는 p_description을 저장). 그래서 반복 생성된 수업은 항상
--   description = NULL이었고 회원 예약 확인창에도 소개가 보이지 않았다.
--   → JSON 행의 'description'을 classes.description에 저장한다(없거나 빈 문자열이면 NULL).
--
-- [QA 10] "모든 반복 수업에 적용"이 시간까지 덮어쓰던 문제는 클라이언트 payload 문제라(각 수업의
--   기존 시작/종료를 그대로 보내면 됨) 시간 보존 자체는 SQL이 필요 없다. 다만 "수업 소개"를 그룹
--   전체에 적용하려면 update_class_group_safe가 description을 받아야 해서, 시그니처(오버로드)는
--   그대로 두고 p_updates JSON 행에 'description' 키가 "있을 때만" 그 값으로 갱신한다
--   (키가 없으면 기존 소개 유지 → 이전 클라이언트와 완전 호환).
--
-- 라이브 정의(2026-10-01 조회)를 기준으로 description 처리만 추가했다. 권한 판정/그 외 로직은 동일.
-- 기존 description이 NULL인 반복수업은 건드리지 않는다(추측 복구 금지 — 별도 제안 SQL은 최종 보고 참고).
-- 여러 번 실행해도 안전. 이 세션에서는 production에 실행하지 않았습니다.
-- ============================================================

create or replace function public.create_recurring_classes_safe(p_center_id uuid, p_rows jsonb, p_is_copy boolean default false)
returns uuid[]
language plpgsql
security definer
set search_path to 'public'
as $function$
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
            center_id, title, description, start_time, end_time, capacity, room_id,
            cancel_deadline_min, booking_deadline_min, recurring_group_id,
            pass_selection_mode, allow_goods, status
        )
        select
            p_center_id,
            r->>'title',
            nullif(btrim(coalesce(r->>'description', '')), ''),
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

create or replace function public.update_class_group_safe(p_group_id uuid, p_title text, p_capacity integer, p_updates jsonb)
returns uuid[]
language plpgsql
security definer
set search_path to 'public'
as $function$
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
            end_time = (u->>'end_time')::timestamptz,
            -- 'description' 키가 있을 때만 갱신(빈 문자열 = 소개 지우기). 키가 없으면 기존 값 유지.
            description = case
                when u ? 'description' then nullif(btrim(coalesce(u->>'description', '')), '')
                else c.description
            end
        from jsonb_array_elements(p_updates) as u
        where c.id = (u->>'id')::uuid and c.recurring_group_id = p_group_id
        returning c.id
    )
    select array_agg(id) into v_ids from upd;

    return coalesce(v_ids, array[]::uuid[]);
end;
$function$;

-- ============================================================
-- 확인(읽기 전용)
-- ============================================================
select proname, pg_get_function_identity_arguments(oid) as args
from pg_proc
where pronamespace = 'public'::regnamespace
  and proname in ('create_recurring_classes_safe', 'update_class_group_safe');

-- (제안만, 실행하지 않음) 소개가 NULL인 기존 반복수업 복구 후보 — 같은 반복 그룹에서 "비어 있지 않은
-- 소개가 정확히 한 종류"뿐인 그룹만 보여 준다. 그런 그룹이 없으면 복구 대상이 아니다.
-- select recurring_group_id, count(*) filter (where description is null) as null_cnt,
--        count(distinct description) filter (where description is not null) as distinct_desc
-- from classes where recurring_group_id is not null group by 1
-- having count(*) filter (where description is null) > 0
--    and count(distinct description) filter (where description is not null) = 1;
