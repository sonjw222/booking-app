-- ============================================================
-- READ-ONLY preflight: fix_progress_category_tree_20261003.sql 적용 전 progress_categories가 이미 깨져 있지 않은지 확인.
-- 데이터를 수정하지 않는다(SELECT만). Supabase SQL Editor에서 직접 실행한다. 순환이 있어도 무한 반복하지 않도록 경로 배열로 cycle-safe하게 작성.
-- 적용 전용 점검(분류/기술 자동 backfill 가능 여부). 기존 구조(최상위=분류, 그 아래=기술)로 안전하게 나눌 수 있으려면:
--   legacy_depth_gt_2=0(3단계 이상 없음), records_on_top_level=0(최상위 분류에 진도 기록 없음), orphan_nodes=0, cross_center_parents=0,
--   self_parents=0, cyclic_nodes=0 이어야 한다. 하나라도 아니면 verdict='FIX_DATA_FIRST' — 자동으로 추측해 migration하지 않는다.
-- 정상 기대: 위 값이 모두 0, max_depth<=2, verdict='OK'. already_migrated=true면 이미 node_type이 있는 상태(이 점검은 적용 전용).
-- ============================================================
with recursive walk(start_id, id, parent_id, lvl, path) as (
    -- 각 노드에서 위로 올라가며 깊이를 센다. path에 이미 있는 id를 다시 만나면 순환이라 더 올라가지 않는다.
    select c.id, c.id, c.parent_id, 1, array[c.id]
      from public.progress_categories c
    union all
    select w.start_id, p.id, p.parent_id, w.lvl + 1, w.path || p.id
      from walk w
      join public.progress_categories p on p.id = w.parent_id
     where not (p.id = any(w.path))
       and w.lvl < 64
),
per_node as (
    select start_id,
           max(lvl) as depth,
           -- 마지막 지점의 parent_id가 이미 지나온 경로에 있으면 순환
           bool_or(parent_id is not null and parent_id = any(path)) as is_cyclic
      from walk
     group by start_id
),
stats as (
    select
        (select count(*) from public.progress_categories c where c.parent_id is not null
            and exists (select 1 from public.progress_categories p where p.id = c.parent_id and p.center_id <> c.center_id)) as cross_center_parents,
        (select count(*) from public.progress_categories where parent_id = id) as self_parents,
        (select count(*) from public.progress_categories c where c.parent_id is not null
            and not exists (select 1 from public.progress_categories p where p.id = c.parent_id)) as orphan_nodes,
        (select count(*) from public.progress_categories c join public.progress_categories p on p.id = c.parent_id where p.parent_id is not null) as legacy_depth_gt_2,
        (select count(*) from public.progress_records r join public.progress_categories c on c.id = r.category_id where c.parent_id is null) as records_on_top_level,
        (select count(*) from public.progress_categories where parent_id is null) as top_level_rows,
        (select count(*) from public.progress_categories where parent_id is not null) as child_rows,
        exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'progress_categories' and column_name = 'node_type') as already_migrated,
        (select count(*) from per_node where is_cyclic) as cyclic_nodes,
        (select count(*) from per_node where depth > 7) as over_depth_7_nodes,
        (select coalesce(max(depth), 0) from per_node where not is_cyclic) as max_depth,
        (select count(*) from public.progress_categories) as total_rows
)
select s.*,
       case when s.cross_center_parents = 0 and s.self_parents = 0 and s.orphan_nodes = 0
             and s.cyclic_nodes = 0 and s.over_depth_7_nodes = 0 and s.max_depth <= 2
             and s.legacy_depth_gt_2 = 0 and s.records_on_top_level = 0
            then 'OK' else 'FIX_DATA_FIRST' end as verdict
  from stats s;
