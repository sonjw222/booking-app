-- fix_reservations_privileges_minimize_20261003.sql가 회수한 권한만 직전(Production) 상태로 복원한다.
begin;
grant insert on table public.reservations to authenticated;
grant references, trigger on table public.reservations to anon, authenticated;
commit;
