-- fix_center_insert_guard_20261008.sql 롤백 — 트리거와 함수만 제거한다(데이터/정책/다른 트리거는 건드리지 않음).
drop trigger if exists trg_guard_center_insert on public.centers;
drop function if exists public.guard_center_insert();
