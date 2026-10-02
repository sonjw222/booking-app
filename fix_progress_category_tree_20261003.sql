-- ============================================================
-- 진도 분류 최대 7단계 계층(2026-10-03) — progress_categories.parent_id(self FK)는 이미 있으므로 새 컬럼 없이 서버 쪽 최종 방어선만 추가한다.
-- 기존 데이터(1~2단계)는 그대로 유효하다(트리거는 INSERT/parent_id·center_id UPDATE 때만 검사).
-- 감사(Production 읽기 전용): FK는 parent_id → progress_categories(id)뿐이고 순환/깊이/센터 일치 검증이 없었으며, RLS(INSERT/UPDATE)는 "자기 row의 center"
-- 권한(customer.progress)만 확인해서 다른 센터 분류를 부모로 지정하는 것도 막지 못했다. 삭제는 FK(on delete 없음)가 하위/기록이 있으면 막는 기존 동작을 유지한다.
-- 검증: 자기 자신 부모 금지 / 같은 센터의 부모만 / 순환 금지(새 부모의 조상에 자신이 있으면 거부) / 깊이 ≤ 7(부모 깊이 + 1 + 자신의 하위 높이) / center_id 변경 금지.
-- 동시성: 같은 센터의 구조 변경(INSERT/parent_id/center_id)은 transaction-scoped advisory lock(센터별, 커밋/롤백 시 자동 해제)으로 직렬화한다 —
--   TX1: A.parent=B, TX2: B.parent=A가 서로 변경 전 상태만 읽고 둘 다 통과하는 순환 race를 막는다. 다른 센터끼리는 서로 막지 않는다.
-- 재실행 안전: create or replace function + drop trigger if exists. 기존 데이터는 이 파일이 수정/삭제하지 않는다(적용 전 verify_progress_category_tree_20261003.sql로 현재 상태 점검).
-- 이 세션에서는 production에 실행하지 않았습니다.
-- ============================================================
begin;

create or replace function public.progress_categories_guard_tree()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    v_parent_center uuid;
    v_parent_depth  integer;
    v_below         integer := 0;
    v_cycle         boolean := false;
begin
    if tg_op = 'UPDATE' and new.center_id is distinct from old.center_id then
        raise exception '분류의 센터는 바꿀 수 없어요';
    end if;
    -- 아래 검증 쿼리들이 읽기 전에 센터 단위 lock을 먼저 잡는다(read committed에서 lock 대기 후의 문장은 다른 TX의 커밋 결과를 본다).
    perform pg_advisory_xact_lock(hashtextextended('progress_categories_tree:' || new.center_id::text, 0));
    if new.parent_id is null then
        return new;
    end if;
    if new.parent_id = new.id then
        raise exception '자기 자신을 상위 분류로 지정할 수 없어요';
    end if;

    select center_id into v_parent_center from public.progress_categories where id = new.parent_id;
    if not found then
        raise exception '상위 분류를 찾을 수 없어요';
    end if;
    if v_parent_center is distinct from new.center_id then
        raise exception '다른 센터의 분류를 상위 분류로 지정할 수 없어요';
    end if;

    -- 새 부모에서 위로 올라가며 깊이를 세고, 자기 자신이 조상에 있으면 순환
    with recursive up(id, parent_id, lvl) as (
        select id, parent_id, 1 from public.progress_categories where id = new.parent_id
        union all
        select c.id, c.parent_id, up.lvl + 1 from public.progress_categories c join up on c.id = up.parent_id where up.lvl < 16
    )
    select max(lvl), coalesce(bool_or(id = new.id), false) into v_parent_depth, v_cycle from up;
    if v_cycle then
        raise exception '하위 분류를 상위 분류로 지정할 수 없어요(순환)';
    end if;

    -- 이동하는 경우 자신의 하위 높이도 포함해 7단계를 넘지 않아야 한다
    if tg_op = 'UPDATE' then
        with recursive down(id, lvl) as (
            select id, 1 from public.progress_categories where parent_id = new.id
            union all
            select c.id, down.lvl + 1 from public.progress_categories c join down on c.parent_id = down.id where down.lvl < 16
        )
        select coalesce(max(lvl), 0) into v_below from down;
    end if;
    if v_parent_depth + 1 + v_below > 7 then
        raise exception '분류는 최대 7단계까지 만들 수 있어요';
    end if;
    return new;
end;
$$;
revoke all on function public.progress_categories_guard_tree() from public, anon, authenticated;

drop trigger if exists progress_categories_guard_tree on public.progress_categories;
create trigger progress_categories_guard_tree
    before insert or update of parent_id, center_id on public.progress_categories
    for each row execute function public.progress_categories_guard_tree();

commit;

-- ============================================================
-- 적용 후 확인(읽기 전용)
-- ============================================================
select
    (select count(*) from pg_trigger where tgname = 'progress_categories_guard_tree' and not tgisinternal) as guard_trigger_must_be_1,
    has_function_privilege('authenticated', 'public.progress_categories_guard_tree()', 'execute') as guard_fn_auth_must_be_false,
    (select count(*) from public.progress_categories c where c.parent_id is not null and not exists (select 1 from public.progress_categories p where p.id = c.parent_id and p.center_id = c.center_id)) as cross_center_parents_must_be_0;
