-- fix_reservations_remaining_privileges_20261004.sql 롤백: 회수한 두 권한만 복원한다(직전 상태: authenticated DELETE, anon SELECT). RLS 정책/다른 권한은 건드리지 않는다.
-- 복원해도 행 접근은 RLS가 제한한다(DELETE는 "매니저 취소예약 정리" 정책, anon은 어떤 정책도 행을 주지 않음).
begin;

grant delete on table public.reservations to authenticated;
grant select on table public.reservations to anon;

commit;
