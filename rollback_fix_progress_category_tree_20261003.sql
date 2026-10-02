begin;
drop trigger if exists progress_categories_guard_tree on public.progress_categories;
drop function if exists public.progress_categories_guard_tree();
commit;
