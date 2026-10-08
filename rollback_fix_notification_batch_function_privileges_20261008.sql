-- fix_notification_batch_function_privileges_20261008.sql 롤백 — 적용 전 상태(PUBLIC 실행 가능)로 되돌린다. 보안 노출이 다시 열리므로 문제 해결 목적일 때만.
grant execute on function public.evaluate_notification_rules() to public, anon, authenticated, service_role;
grant execute on function public.notify_expiring_passes() to public, anon, authenticated, service_role;
grant execute on function public.notify_upcoming_reservations() to public, anon, authenticated, service_role;
