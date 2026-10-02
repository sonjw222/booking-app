-- ============================================================
-- 관리자/수업/회원 예약 UX 보완 (2026-10-02)
--
--  [B] 요일/시간 선택형 수강권 구매 서버 검증
--      products.weekday_selectable=true인 수강권은 주문에 요일(selected_day_of_week)이 반드시 있어야 하고,
--      그 요일이 이 상품의 예약조건(membership_schedule_rules)에 등록된 요일이어야 한다. time_selectable=true면 시간도 같은 규칙.
--      (클라이언트가 선택을 빠뜨리거나 공개 목록 모델로 결제를 진행하면 제한 없는 수강권이 발급될 수 있었다.)
--      Production 실제 원인: 요일 선택형으로 저장된 활성 수강권에 예약조건(요일)이 0개라 구매 화면에 선택 후보가 없었다 — 상품 설정이 source of truth.
--  [C] 반복 수업 전체 적용에 "예약 가능 수강권 설정"도 포함: update_class_group_safe(라이브 정의 + 선택 키 pass_selection_mode/allowed_product_ids).
--      같은 트랜잭션에서 classes.pass_selection_mode 갱신 + class_allowed_products 교체(부분 성공 없음). 키가 없으면 기존 수강권 설정 보존.
--  [E] 담당 강사 "선택한 순서" 영속화: class_trainers.sort_order + 3개 setter RPC + class_trainer_names ORDER BY.
--      기존 행은 (class_id별 id 순)으로 0부터 backfill — 과거 선택 순서는 복원할 수 없으므로 안정적인 기준일 뿐이고, 이후 저장부터 정확한 선택 순서가 보장된다.
--  PUBLIC/anon EXECUTE 감사: 교체하는 RPC는 로그인 사용자(my_account_id/has_permission)만 의미가 있어 PUBLIC/anon 실행을 회수하고 authenticated/service_role만 허용한다.
--
-- 변경하지 않는 것: 수업 시간/날짜 정책, 다른 공통 필드 적용 로직, 강사 권한 모델(own/other), 예약 RPC.
-- 이 세션에서는 production에 실행하지 않았습니다.
-- ============================================================
BEGIN;

-- [B] 요일/시간 선택형 수강권 주문 검증(service_role/서버 작업 포함 모든 INSERT)
create or replace function orders_require_schedule_selection()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    v_weekday boolean;
    v_time    boolean;
    v_kind    text;
begin
    if new.product_id is null then
        return new;
    end if;
    select coalesce(weekday_selectable, false), coalesce(time_selectable, false), product_kind
      into v_weekday, v_time, v_kind
      from products where id = new.product_id;
    if not found or not v_weekday or v_kind = 'goods' then
        return new;
    end if;

    if new.selected_day_of_week is null then
        raise exception '이용할 요일을 선택해 주세요';
    end if;
    if not exists (
        select 1 from membership_schedule_rules r
         where r.product_id = new.product_id and r.day_of_week = new.selected_day_of_week
    ) then
        raise exception '선택할 수 없는 요일이에요. 센터에 문의해주세요';
    end if;
    if v_time then
        if new.selected_start_time is null then
            raise exception '이용할 시간을 선택해 주세요';
        end if;
        if not exists (
            select 1 from membership_schedule_rules r
             where r.product_id = new.product_id and r.day_of_week = new.selected_day_of_week and r.start_time = new.selected_start_time
        ) then
            raise exception '선택할 수 없는 시간이에요. 센터에 문의해주세요';
        end if;
    end if;
    return new;
end;
$$;
revoke all on function orders_require_schedule_selection() from public, anon, authenticated;

drop trigger if exists orders_require_schedule_selection on orders;
create trigger orders_require_schedule_selection
    before insert on orders
    for each row execute function orders_require_schedule_selection();

-- [E] 담당 강사 표시 순서
alter table class_trainers add column if not exists sort_order integer not null default 0;

update class_trainers t
   set sort_order = r.pos
  from (select id, (row_number() over (partition by class_id order by id) - 1)::int as pos from class_trainers) r
 where r.id = t.id;

create index if not exists idx_class_trainers_class_order on class_trainers (class_id, sort_order);

-- [E] 선택 순서를 저장하는 setter 3종(라이브 정의 + sort_order). 권한 검사/삭제 후 재삽입 구조는 그대로.
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
        -- 선택한 순서(배열 순서)를 sort_order로 저장(중복은 첫 위치만)
        insert into class_trainers (class_id, account_id, sort_order)
        select p_class_id, t.aid, t.pos from (select x.aid, (row_number() over (order by min(x.ord)) - 1)::int as pos from unnest(p_account_ids) with ordinality as x(aid, ord) group by x.aid) t;
    end if;
end;
$function$;

revoke all on function set_class_trainers_safe(uuid, uuid[]) from public, anon;
grant execute on function set_class_trainers_safe(uuid, uuid[]) to authenticated, service_role;

CREATE OR REPLACE FUNCTION public.set_class_trainers_bulk_safe(p_class_ids uuid[], p_account_ids uuid[])
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_center_id uuid;
    v_ids       uuid[];
    v_found     integer;
    v_centers   integer;
begin
    if p_class_ids is null or array_length(p_class_ids, 1) is null then
        return;
    end if;

    -- [NEW 2026-10-02] 교차 센터 id 주입 차단: 모든 수업이 존재하고 같은 센터여야 한다(권한은 그 센터 기준). 검증은 INSERT보다 먼저.
    -- (이전에는 첫 번째 수업의 센터 권한만 확인한 뒤 SECURITY DEFINER로 배열 전체에 INSERT해, 다른 센터 수업을 섞어 넣을 수 있었다.)
    select array_agg(distinct x) into v_ids from unnest(p_class_ids) x;   -- 중복 제거(null이 있으면 아래 존재 검사에서 거부)
    select count(*), count(distinct center_id), min(center_id::text)::uuid into v_found, v_centers, v_center_id
      from classes where id = any(v_ids);
    if v_found <> array_length(v_ids, 1) then
        raise exception '수업을 찾을 수 없어요';
    end if;
    if v_centers <> 1 then
        raise exception '같은 센터의 수업만 한 번에 지정할 수 있어요';
    end if;
    if not (has_permission(v_center_id, 'schedule.own.group.create') or is_platform_admin()) then
        raise exception '담당 강사를 지정할 권한이 없어요';
    end if;

    if p_account_ids is not null and array_length(p_account_ids, 1) > 0 then
        insert into class_trainers (class_id, account_id, sort_order)
        select cid, t.aid, t.pos from unnest(v_ids) as cid, (select x.aid, (row_number() over (order by min(x.ord)) - 1)::int as pos from unnest(p_account_ids) with ordinality as x(aid, ord) group by x.aid) t;
    end if;
end;
$function$;

revoke all on function set_class_trainers_bulk_safe(uuid[], uuid[]) from public, anon;
grant execute on function set_class_trainers_bulk_safe(uuid[], uuid[]) to authenticated, service_role;

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
    v_ids       uuid[];
    v_found     integer;
    v_centers   integer;
    v_groups    integer;
    v_no_group  boolean;
begin
    if p_class_ids is null or array_length(p_class_ids, 1) is null then
        return;
    end if;

    -- [NEW 2026-10-02] 교차 센터/교차 그룹 주입 차단: 모든 수업이 존재하고, 같은 센터이며, 같은 반복 그룹(recurring_group_id가 null이 아님)이어야 한다.
    -- 검증은 DELETE/INSERT보다 먼저, own/other 권한 판정도 검증된 id 집합으로만 한다.
    select array_agg(distinct x) into v_ids from unnest(p_class_ids) x;
    select count(*), count(distinct center_id), count(distinct recurring_group_id), coalesce(bool_or(recurring_group_id is null), false), min(center_id::text)::uuid
      into v_found, v_centers, v_groups, v_no_group, v_center_id
      from classes where id = any(v_ids);
    if v_found <> array_length(v_ids, 1) then
        raise exception '수업을 찾을 수 없어요';
    end if;
    if v_centers <> 1 then
        raise exception '같은 센터의 수업만 한 번에 지정할 수 있어요';
    end if;
    if v_no_group or v_groups <> 1 then
        raise exception '같은 반복 수업 그룹의 수업만 한 번에 지정할 수 있어요';
    end if;

    v_is_own := not exists (select 1 from class_trainers where class_id = any(v_ids))
             or exists (select 1 from class_trainers where class_id = any(v_ids) and account_id = my_account_id());
    v_key := 'schedule.' || (case when v_is_own then 'own' else 'other' end) || '.group.update';
    if not (has_permission(v_center_id, v_key) or is_platform_admin()) then
        raise exception '담당 강사를 지정할 권한이 없어요';
    end if;

    delete from class_trainers where class_id = any(v_ids);
    if p_account_ids is not null and array_length(p_account_ids, 1) > 0 then
        insert into class_trainers (class_id, account_id, sort_order)
        select cid, t.aid, t.pos from unnest(v_ids) as cid, (select x.aid, (row_number() over (order by min(x.ord)) - 1)::int as pos from unnest(p_account_ids) with ordinality as x(aid, ord) group by x.aid) t;
    end if;
end;
$function$;

revoke all on function set_class_trainers_for_group_safe(uuid[], uuid[]) from public, anon;
grant execute on function set_class_trainers_for_group_safe(uuid[], uuid[]) to authenticated, service_role;

-- [E] 이름 조회도 같은 순서로(반환 컬럼 동일 — 호출부는 행 순서대로 이름 배열을 만든다)
create or replace function class_trainer_names(p_class_ids uuid[])
returns table(class_id uuid, account_id uuid, name text)
language sql
stable
security definer
set search_path = public
as $$
    select ct.class_id, ct.account_id, a.name
    from class_trainers ct
    join accounts a on a.id = ct.account_id
    where ct.class_id = any(p_class_ids)
      and auth.uid() is not null
    order by ct.class_id, ct.sort_order, ct.id;
$$;

-- [C] 반복 수업 일괄 수정(공통 필드 + 선택적 수강권 설정)
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

    -- [NEW 2026-10-02] 반복 수업 전체 적용에 "예약 가능 수강권 설정"도 포함할 수 있다 — 행의 선택 키:
    --   pass_selection_mode('all'|'selected'), allowed_product_ids(uuid 문자열 배열, 'selected'일 때만 의미)
    -- 모든 검증을 갱신 전에 끝내고, 수업 갱신과 허용 수강권 교체는 같은 트랜잭션(이 함수)에서 처리한다.
    for v_row in select u from jsonb_array_elements(p_updates) u where u ? 'pass_selection_mode' loop
        if (v_row->>'pass_selection_mode') not in ('all', 'selected') then
            raise exception '수강권 허용 방식이 올바르지 않아요';
        end if;
        if (v_row->>'pass_selection_mode') = 'selected' then
            if coalesce(jsonb_array_length(v_row->'allowed_product_ids'), 0) = 0 then
                raise exception '예약 가능 수강권을 1개 이상 선택해주세요';
            end if;
            if exists (
                select 1 from jsonb_array_elements_text(v_row->'allowed_product_ids') pid
                 where not exists (select 1 from products p where p.id = pid::uuid and p.center_id = v_center_id and p.product_kind = 'pass')
            ) then
                raise exception '이 센터의 수강권만 선택할 수 있어요';
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
            booking_deadline_min = case when u ? 'booking_deadline_min' then nullif(u->>'booking_deadline_min', '')::int else c.booking_deadline_min end,
            pass_selection_mode = case when u ? 'pass_selection_mode' then u->>'pass_selection_mode' else c.pass_selection_mode end
        from jsonb_array_elements(p_updates) as u
        where c.id = (u->>'id')::uuid
          and c.recurring_group_id = p_group_id
          and c.center_id = v_center_id
        returning c.id
    )
    select array_agg(id) into v_ids from upd;

    -- 허용 수강권 교체: 키가 온 행만(없으면 그 수업의 기존 설정 보존). 'all'은 행을 비워 "그 순간의 모든 수강권"을 가리킨다.
    if v_ids is not null then
        delete from class_allowed_products cap
         using jsonb_array_elements(p_updates) u
         where u ? 'pass_selection_mode' and cap.class_id = (u->>'id')::uuid and cap.class_id = any(v_ids);
        insert into class_allowed_products (class_id, product_id)
        select distinct (u->>'id')::uuid, pid::uuid
          from jsonb_array_elements(p_updates) u, jsonb_array_elements_text(u->'allowed_product_ids') pid
         where u ? 'pass_selection_mode' and u->>'pass_selection_mode' = 'selected' and (u->>'id')::uuid = any(v_ids);
    end if;

    return coalesce(v_ids, array[]::uuid[]);
end;
$function$;

revoke all on function update_class_group_safe(uuid, text, integer, jsonb) from public, anon;
grant execute on function update_class_group_safe(uuid, text, integer, jsonb) to authenticated, service_role;

COMMIT;

-- ============================================================
-- 적용 전 확인(읽기 전용)
-- ============================================================
-- select count(*) as class_trainers_rows, count(distinct class_id) as classes from class_trainers;
-- select p.id, p.name, p.weekday_selectable, p.time_selectable,
--        (select count(*) from membership_schedule_rules r where r.product_id = p.id and r.day_of_week is not null) as day_rules
--   from products p where p.weekday_selectable and p.is_active;      -- day_rules=0인 활성 상품은 적용 후 구매 불가(예약조건 등록 필요)
-- select proname, has_function_privilege('anon', oid, 'execute') as anon_exec from pg_proc
--  where pronamespace = 'public'::regnamespace and proname in ('set_class_trainers_safe', 'set_class_trainers_bulk_safe', 'set_class_trainers_for_group_safe', 'update_class_group_safe');

-- ============================================================
-- 적용 후 확인(읽기 전용)
-- ============================================================
select
    (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'class_trainers' and column_name = 'sort_order') as sort_order_column_must_be_1,
    (select count(*) from class_trainers) = (select count(*) from class_trainers where sort_order >= 0) as backfill_complete_must_be_true,
    (select count(*) from (select class_id, sort_order from class_trainers group by class_id, sort_order having count(*) > 1) d) as duplicate_positions_must_be_0,
    (select count(*) from pg_indexes where indexname = 'idx_class_trainers_class_order') as order_index_must_be_1,
    (select count(*) from pg_trigger where tgname = 'orders_require_schedule_selection' and not tgisinternal) as schedule_trigger_must_be_1,
    (select pg_get_functiondef('class_trainer_names(uuid[])'::regprocedure) like '%order by ct.class_id, ct.sort_order%') as names_ordered_must_be_true,
    (select pg_get_functiondef('set_class_trainers_safe(uuid,uuid[])'::regprocedure) like '%sort_order%') as setter_single_ordered_must_be_true,
    (select pg_get_functiondef('set_class_trainers_bulk_safe(uuid[],uuid[])'::regprocedure) like '%sort_order%') as setter_bulk_ordered_must_be_true,
    (select pg_get_functiondef('set_class_trainers_bulk_safe(uuid[],uuid[])'::regprocedure) like '%같은 센터의 수업만%') as setter_bulk_same_center_must_be_true,
    (select pg_get_functiondef('set_class_trainers_for_group_safe(uuid[],uuid[])'::regprocedure) like '%같은 반복 수업 그룹의 수업만%') as setter_group_same_group_must_be_true,
    (select pg_get_functiondef('set_class_trainers_for_group_safe(uuid[],uuid[])'::regprocedure) like '%sort_order%') as setter_group_ordered_must_be_true,
    (select pg_get_functiondef('update_class_group_safe(uuid,text,integer,jsonb)'::regprocedure) like '%allowed_product_ids%') as group_rpc_has_pass_policy_must_be_true,
    has_function_privilege('anon', 'update_class_group_safe(uuid,text,integer,jsonb)', 'execute') as group_rpc_anon_must_be_false,
    has_function_privilege('anon', 'set_class_trainers_safe(uuid,uuid[])', 'execute') as trainers_anon_must_be_false,
    has_function_privilege('authenticated', 'update_class_group_safe(uuid,text,integer,jsonb)', 'execute') as group_rpc_auth_must_be_true,
    has_function_privilege('authenticated', 'orders_require_schedule_selection()', 'execute') as schedule_trigger_fn_auth_must_be_false;
