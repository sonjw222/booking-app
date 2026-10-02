-- 이 migration이 추가한 것만 되돌린다(trigger 2개, function 2개, 제약 2개, node_type 컬럼). 기존 데이터(행/parent_id/기록)는 삭제하지 않는다.
-- 주의: 새 웹(node_type을 INSERT/SELECT)이 배포된 상태에서 이 rollback을 먼저 실행하면 새 웹의 진도 화면이 실패한다 — 웹을 먼저 되돌리거나, 되돌린 뒤 옛 웹 상태로 운영하세요.
-- rollback 후 데이터는 parent_id 계층 그대로 남는다: 옛 2단계 화면은 최상위와 그 직계 하위만 보여주므로, 3단계 이상 분류를 이미 만들었다면 옛 화면에서 보이지 않을 수 있다(데이터는 유지).
begin;
drop trigger if exists progress_records_guard_skill on public.progress_records;
drop function if exists public.progress_records_guard_skill();
drop trigger if exists progress_categories_guard_tree on public.progress_categories;
drop function if exists public.progress_categories_guard_tree();
alter table public.progress_categories drop constraint if exists progress_categories_skill_has_parent;
alter table public.progress_categories drop constraint if exists progress_categories_node_type_check;
alter table public.progress_categories drop column if exists node_type;
commit;
