-- ============================================================
-- 진도 분류/기술 트리(2026-10-03, 최종 형태) — progress_categories를 안전하게 확장한다(새 테이블 없음).
--   · node_type 컬럼('category' | 'skill'): 행의 의미를 "자식이 있는지"로 추론하지 않고 명시한다.
--   · CATEGORY: 최상위이거나 category 아래. 최대 7단계(기술은 깊이에 포함하지 않는다 — 7단계 분류 아래에도 기술을 둘 수 있다).
--   · SKILL: 반드시 category 아래(parent_id 필수), 다른 행의 부모가 될 수 없고, 진도 기록(progress_records)은 skill에만 가능.
--   · node_type은 만든 뒤 바꿀 수 없다(분류↔기술 전환 기능 없음).
-- Production 감사(읽기 전용, 2026-10-03): 4 top-level + 74 child, 3단계 이상 0, 고아 0, progress_records 0건 → 기존 구조(top=분류, child=기술)로 안전하게 backfill 가능.
--   그래도 아래 [0]이 적용 시점에 다시 검사해서, 애매한 데이터(3단계 이상/최상위에 기록/다른 센터 부모)가 있으면 추측하지 않고 전체를 중단(rollback)한다.
-- 구버전 웹 호환: node_type 없이 INSERT하는 옛 코드는 BEFORE INSERT trigger가 옛 의미(parent 없음=분류, 있음=기술)로 채운다. 새 웹은 항상 node_type을 명시한다.
-- 동시성: 같은 센터의 구조 변경은 transaction-scoped advisory lock(센터별, 커밋/롤백 시 자동 해제)으로 직렬화한다 — 순환 race 방지. 다른 센터끼리는 막지 않는다.
-- 재실행 안전: add column if not exists / 제약은 존재 확인 후 추가 / create or replace function / drop trigger if exists. 기존 데이터는 삭제하지 않는다.
-- 이 세션에서는 production에 실행하지 않았습니다. 적용 전 verify_progress_category_tree_20261003.sql을 먼저 실행하세요.
-- ============================================================
begin;

-- [0] 자동 backfill 안전성 재검사(아직 node_type이 없는 행만 대상) — 하나라도 걸리면 예외로 전체 중단
do $$
declare
    v_deep integer; v_cross integer; v_orphan integer; v_rec_top integer;
begin
    if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='progress_categories' and column_name='node_type') then
        select count(*) into v_deep from public.progress_categories c join public.progress_categories p on p.id = c.parent_id where p.parent_id is not null;
        select count(*) into v_cross from public.progress_categories c join public.progress_categories p on p.id = c.parent_id where p.center_id <> c.center_id;
        select count(*) into v_orphan from public.progress_categories c where c.parent_id is not null and not exists (select 1 from public.progress_categories p where p.id = c.parent_id);
        select count(*) into v_rec_top from public.progress_records r join public.progress_categories c on c.id = r.category_id where c.parent_id is null;
        if v_deep > 0 or v_cross > 0 or v_orphan > 0 or v_rec_top > 0 then
            raise exception '기존 진도 분류 데이터를 자동으로 분류/기술로 나눌 수 없어요(3단계 이상 %, 다른 센터 부모 %, 고아 %, 최상위에 기록 %). verify_progress_category_tree_20261003.sql로 확인 후 데이터를 먼저 정리하세요', v_deep, v_cross, v_orphan, v_rec_top;
        end if;
    end if;
end $$;

-- [1] 컬럼 + backfill(기존 top-level → category, 기존 child → skill) + 제약
alter table public.progress_categories add column if not exists node_type text;
update public.progress_categories set node_type = case when parent_id is null then 'category' else 'skill' end where node_type is null;
alter table public.progress_categories alter column node_type set not null;

do $$
begin
    if not exists (select 1 from pg_constraint where conname = 'progress_categories_node_type_check' and conrelid = 'public.progress_categories'::regclass) then
        alter table public.progress_categories add constraint progress_categories_node_type_check check (node_type in ('category', 'skill'));
    end if;
    if not exists (select 1 from pg_constraint where conname = 'progress_categories_skill_has_parent' and conrelid = 'public.progress_categories'::regclass) then
        alter table public.progress_categories add constraint progress_categories_skill_has_parent check (node_type = 'category' or parent_id is not null);
    end if;
end $$;

-- [2] 트리 불변조건 trigger
create or replace function public.progress_categories_guard_tree()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    v_parent_center uuid;
    v_parent_type   text;
    v_parent_depth  integer;
    v_below         integer := 0;
    v_cycle         boolean := false;
begin
    if tg_op = 'UPDATE' then
        if new.center_id is distinct from old.center_id then
            raise exception '분류의 센터는 바꿀 수 없어요';
        end if;
        if new.node_type is distinct from old.node_type then
            raise exception '분류와 기술은 서로 바꿀 수 없어요';
        end if;
    end if;
    -- 아래 검증 쿼리들이 읽기 전에 센터 단위 lock을 먼저 잡는다(read committed에서 lock 대기 후의 문장은 다른 TX의 커밋 결과를 본다).
    perform pg_advisory_xact_lock(hashtextextended('progress_categories_tree:' || new.center_id::text, 0));

    -- 구버전 웹 호환: node_type 없이 들어온 INSERT는 옛 의미로 채운다(최상위=분류, 하위=기술)
    if new.node_type is null then
        new.node_type := case when new.parent_id is null then 'category' else 'skill' end;
    end if;
    if new.node_type not in ('category', 'skill') then
        raise exception '분류 유형이 올바르지 않아요';
    end if;
    if new.parent_id is null then
        if new.node_type = 'skill' then
            raise exception '기술은 분류 아래에만 만들 수 있어요';
        end if;
        return new;
    end if;
    if new.parent_id = new.id then
        raise exception '자기 자신을 상위 분류로 지정할 수 없어요';
    end if;

    select center_id, node_type into v_parent_center, v_parent_type from public.progress_categories where id = new.parent_id;
    if not found then
        raise exception '상위 분류를 찾을 수 없어요';
    end if;
    if v_parent_center is distinct from new.center_id then
        raise exception '다른 센터의 분류를 상위 분류로 지정할 수 없어요';
    end if;
    if v_parent_type <> 'category' then
        raise exception '기술 아래에는 분류나 기술을 만들 수 없어요';
    end if;

    -- 새 부모에서 위로 올라가며 분류 깊이를 세고, 자기 자신이 조상에 있으면 순환
    with recursive up(id, parent_id, lvl) as (
        select id, parent_id, 1 from public.progress_categories where id = new.parent_id
        union all
        select c.id, c.parent_id, up.lvl + 1 from public.progress_categories c join up on c.id = up.parent_id where up.lvl < 16
    )
    select max(lvl), coalesce(bool_or(id = new.id), false) into v_parent_depth, v_cycle from up;
    if v_cycle then
        raise exception '하위 분류를 상위 분류로 지정할 수 없어요(순환)';
    end if;

    -- 분류 깊이만 7단계로 제한(기술은 깊이에 포함하지 않는다). 분류를 옮기는 경우 자신의 하위 "분류" 높이도 포함한다.
    if new.node_type = 'category' then
        if tg_op = 'UPDATE' then
            with recursive down(id, lvl) as (
                select id, 1 from public.progress_categories where parent_id = new.id and node_type = 'category'
                union all
                select c.id, down.lvl + 1 from public.progress_categories c join down on c.parent_id = down.id where c.node_type = 'category' and down.lvl < 16
            )
            select coalesce(max(lvl), 0) into v_below from down;
        end if;
        if v_parent_depth + 1 + v_below > 7 then
            raise exception '분류는 최대 7단계까지 만들 수 있어요';
        end if;
    end if;
    return new;
end;
$$;
revoke all on function public.progress_categories_guard_tree() from public, anon, authenticated;

drop trigger if exists progress_categories_guard_tree on public.progress_categories;
create trigger progress_categories_guard_tree
    before insert or update of parent_id, center_id, node_type on public.progress_categories
    for each row execute function public.progress_categories_guard_tree();

-- [3] 진도 기록은 skill에만 — UI에서 숨기는 것과 별개로 직접 INSERT/UPDATE도 서버가 막는다. 기존 RLS/FK는 그대로.
create or replace function public.progress_records_guard_skill()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    v_type text;
begin
    select node_type into v_type from public.progress_categories where id = new.category_id;
    if not found then
        raise exception '기술을 찾을 수 없어요';
    end if;
    if v_type <> 'skill' then
        raise exception '분류에는 진도를 기록할 수 없어요. 기술을 선택해주세요';
    end if;
    return new;
end;
$$;
revoke all on function public.progress_records_guard_skill() from public, anon, authenticated;

drop trigger if exists progress_records_guard_skill on public.progress_records;
create trigger progress_records_guard_skill
    before insert or update of category_id on public.progress_records
    for each row execute function public.progress_records_guard_skill();

commit;

-- ============================================================
-- 적용 후 확인(읽기 전용)
-- ============================================================
select
    (select count(*) from pg_trigger where tgname = 'progress_categories_guard_tree' and not tgisinternal) as tree_trigger_must_be_1,
    (select count(*) from pg_trigger where tgname = 'progress_records_guard_skill' and not tgisinternal) as record_trigger_must_be_1,
    has_function_privilege('authenticated', 'public.progress_categories_guard_tree()', 'execute') as tree_fn_auth_must_be_false,
    has_function_privilege('authenticated', 'public.progress_records_guard_skill()', 'execute') as record_fn_auth_must_be_false,
    (select count(*) from public.progress_categories where node_type is null) as null_node_type_must_be_0,
    (select count(*) from public.progress_categories where node_type = 'skill' and parent_id is null) as skill_without_parent_must_be_0,
    (select count(*) from public.progress_categories c join public.progress_categories p on p.id = c.parent_id where p.node_type = 'skill') as children_of_skill_must_be_0,
    (select count(*) from public.progress_records r join public.progress_categories c on c.id = r.category_id where c.node_type <> 'skill') as records_on_category_must_be_0;
