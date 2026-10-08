-- fix_ensure_center_member_privileges_20261008.sql 롤백 — 적용 전 상태(PUBLIC 실행 가능 = anon/authenticated 직접 호출 가능)로 되돌린다. 보안 노출이 다시 열리므로 문제 해결 목적일 때만.
grant execute on function public.ensure_center_member(uuid, uuid) to public, anon, authenticated, service_role;
